/**
 * ISIS Backend – PREP con doble captura asimétrica (humano + IA)
 * Versión mejorada: extraerVotos robusto, validación real, health con disk_free,
 * captura_humana actualizada, manejo de errores resiliente.
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs-extra');
const crypto = require('crypto');
const tesseract = require('tesseract.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

fs.ensureDirSync(path.join(__dirname, 'uploads'));
fs.ensureDirSync(path.join(__dirname, 'corruptas'));

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const upload = multer({
    dest: path.join(__dirname, 'uploads/'),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIMES.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Solo JPG, PNG, WEBP o PDF'));
    }
});

let ocrDisponible = true;

const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));

// ─── Helpers de base de datos ────────────────────────────────────────────────

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
}

// ─── Utilidades generales ────────────────────────────────────────────────────

function calcularHash(filePath) {
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseJsonField(value, fallback = null) {
    if (value == null) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function actaConUrls(row) {
    if (!row) return row;
    return {
        ...row,
        metadata: parseJsonField(row.metadata, {}),
        datos_ocr: parseJsonField(row.datos_ocr, {}),
        datos_corregidos: parseJsonField(row.datos_corregidos),
        ia_observaciones: parseJsonField(row.ia_observaciones, []),
        ocr_exitoso: !!row.ocr_exitoso,
        requiere_verificacion_humana: !!row.requiere_verificacion_humana,
        imagen_url: row.imagen_path ? `/uploads/${row.imagen_path}` : null
    };
}

function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

function getUsuario(req) {
    return req.body?.usuario || req.headers['x-usuario'] || 'operador-cael';
}

function datosIdenticos(a, b) {
    const keysA = Object.keys(a || {}).sort();
    const keysB = Object.keys(b || {}).sort();
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key, i) => key === keysB[i] && a[key] === b[key]);
}

// ─── Extracción de votos mejorada ─────────────────────────────────────────────
/**
 * Reconoce partidos por nombre completo o sigla en el texto OCR.
 * Busca el número más cercano a la derecha (o abajo) de cada partido.
 * También detecta votos nulos y candidaturas no registradas.
 * Si no encuentra un partido, asigna null (no 0) para distinguir ausencia.
 */
function extraerVotos(texto) {
    // Mapa de alias → clave canónica
    const ALIAS_PARTIDOS = {
        PAN: ['PAN', 'PARTIDO ACCION NACIONAL', 'PARTIDO ACCIÓN NACIONAL', 'ACCION NACIONAL'],
        PRI: ['PRI', 'PARTIDO REVOLUCIONARIO INSTITUCIONAL', 'REVOLUCIONARIO INSTITUCIONAL'],
        MORENA: ['MORENA', 'MOVIMIENTO REGENERACION NACIONAL', 'MOVIMIENTO REGENERACIÓN NACIONAL'],
        VERDE: ['VERDE', 'PVEM', 'PARTIDO VERDE ECOLOGISTA', 'VERDE ECOLOGISTA'],
        PT: ['PT', 'PARTIDO DEL TRABAJO', 'DEL TRABAJO'],
        MC: ['MC', 'MOVIMIENTO CIUDADANO', 'CIUDADANO'],
    };

    const textoNorm = texto.toUpperCase().replace(/\s+/g, ' ');
    const votos = {};

    for (const [partido, aliases] of Object.entries(ALIAS_PARTIDOS)) {
        let encontrado = null;

        for (const alias of aliases) {
            // Busca el alias y captura el primer número que aparece tras él (hasta 80 chars)
            const regex = new RegExp(`${alias}[^\\d]{0,80}?(\\d{1,4})`, 'i');
            const match = textoNorm.match(regex);
            if (match) {
                encontrado = parseInt(match[1], 10);
                break;
            }
        }

        // null indica que el partido no se encontró en el texto (diferente a 0 votos)
        votos[partido] = encontrado;
    }

    // Votos nulos: busca "NULOS", "VOTOS NULOS", "NULL"
    const nulosMatch = textoNorm.match(/(?:VOTOS?\s+)?NULOS?[^\d]{0,30}?(\d{1,4})/);
    votos.nulos = nulosMatch ? parseInt(nulosMatch[1], 10) : null;

    // Candidaturas no registradas: "NO REGISTRADOS", "NO REG", "CANDIDATURA NO REGISTRADA"
    const noRegMatch = textoNorm.match(/(?:CANDIDATURA\s+)?NO\s+REGISTRAD[OA]S?[^\d]{0,30}?(\d{1,4})/);
    votos.no_registrados = noRegMatch ? parseInt(noRegMatch[1], 10) : null;

    // Total de personas que votaron
    const totalMatch = textoNorm.match(/TOTAL[^\d]{0,40}?(\d{1,4})/);
    votos.personas_votaron = totalMatch ? parseInt(totalMatch[1], 10) : null;

    return votos;
}

// ─── Validación de consistencia mejorada ──────────────────────────────────────
/**
 * Valida que los datos extraídos sean internamente consistentes.
 * Reglas:
 *   1. Ningún partido con valor negativo.
 *   2. Si personas_votaron está presente:
 *        suma_partidos + nulos + no_registrados ≈ personas_votaron
 *   3. Si personas_votaron > 2000, baja confianza (casilla normal).
 *   4. Partidos con null (no encontrados) penalizan confianza levemente.
 */
function validarActaIAConsistencia(datos) {
    const observaciones = [];
    let confianza = 100;

    const PARTIDOS_PRINCIPALES = ['PAN', 'PRI', 'MORENA', 'VERDE', 'PT', 'MC'];
    const MAX_VOTOS_CASILLA = 2000; // umbral para casilla normal

    // 1. Validar valores individuales
    for (const partido of PARTIDOS_PRINCIPALES) {
        const valor = datos[partido];
        if (valor === undefined || valor === null) {
            observaciones.push(`No se encontró ${partido} en el texto`);
            confianza -= 8; // penaliza menos que antes porque puede ser legítimo
        } else if (Number.isNaN(valor) || valor < 0) {
            observaciones.push(`${partido} tiene un valor inválido o negativo (${valor})`);
            confianza -= 15;
        }
    }

    // 2. Calcular suma de todos los votos emitidos
    const sumaPartidos = PARTIDOS_PRINCIPALES.reduce(
        (acc, p) => acc + (Number(datos[p]) || 0), 0
    );
    const nulos = Number(datos.nulos) || 0;
    const noReg = Number(datos.no_registrados) || 0;
    const sumaTotal = sumaPartidos + nulos + noReg;
    const totalPersonas = datos.personas_votaron != null ? Number(datos.personas_votaron) : null;

    // 3. Cruzar suma vs total declarado
    if (totalPersonas !== null && totalPersonas > 0) {
        if (sumaTotal > totalPersonas) {
            observaciones.push(
                `La suma de votos (${sumaTotal}) supera el total de personas que votaron (${totalPersonas})`
            );
            confianza -= 30;
        } else if (sumaTotal < totalPersonas * 0.5 && totalPersonas > 10) {
            observaciones.push(
                `La suma de votos (${sumaTotal}) es muy baja vs el total declarado (${totalPersonas})`
            );
            confianza -= 20;
        } else if (sumaTotal !== totalPersonas) {
            // Diferencia tolerable: podría ser error menor de OCR
            const diferencia = Math.abs(sumaTotal - totalPersonas);
            if (diferencia > 5) {
                observaciones.push(
                    `Diferencia de ${diferencia} votos entre la suma (${sumaTotal}) y el total (${totalPersonas})`
                );
                confianza -= 10;
            }
        }
    } else if (sumaPartidos === 0) {
        observaciones.push('No se detectaron votos de ningún partido');
        confianza -= 30;
    }

    // 4. Umbral de casilla normal
    const referenciaTotal = totalPersonas ?? sumaTotal;
    if (referenciaTotal > MAX_VOTOS_CASILLA) {
        observaciones.push(
            `Total de votos (${referenciaTotal}) excede el umbral normal de casilla (${MAX_VOTOS_CASILLA})`
        );
        confianza -= 20;
    }

    return {
        confianza: Math.max(0, Math.min(100, confianza)),
        observaciones
    };
}

// ─── Validación de integridad de archivo ──────────────────────────────────────

function validarIntegridadArchivo(filePath, mimetype) {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 50) return false;
    if (mimetype === 'application/pdf') return buf.slice(0, 4).toString() === '%PDF';
    if (mimetype === 'image/png') return buf[0] === 0x89 && buf[1] === 0x50;
    if (mimetype === 'image/jpeg' || mimetype === 'image/webp') {
        return buf[0] === 0xff || buf.slice(0, 4).toString() === 'RIFF';
    }
    return true;
}

async function moverACorruptas(filePath, nombre) {
    const dest = path.join(__dirname, 'corruptas', nombre);
    await fs.move(filePath, dest, { overwrite: true });
    return dest;
}

// ─── Pipeline OCR con fallback ────────────────────────────────────────────────

async function procesarOCR(filePath, mimetype) {
    // PDFs no pasan por OCR de imagen
    if (mimetype === 'application/pdf') {
        return {
            ocr_exitoso: false,
            texto: '',
            votos: {},
            confianza: 0,
            observaciones: ['PDF recibido — OCR no aplicable, captura manual requerida'],
            requiere_verificacion_humana: true
        };
    }

    try {
        const { data: { text } } = await tesseract.recognize(filePath, 'spa');

        if (!text || text.trim().length < 8) {
            return {
                ocr_exitoso: false,
                texto: text || '',
                votos: {},
                confianza: 0,
                observaciones: ['OCR no detectó texto legible — verificación humana obligatoria'],
                requiere_verificacion_humana: true
            };
        }

        const votos = extraerVotos(text);
        const { confianza, observaciones } = validarActaIAConsistencia(votos);
        const requiere = confianza < 50 || observaciones.length > 2;

        return {
            ocr_exitoso: true,
            texto: text,
            votos,
            confianza,
            observaciones,
            requiere_verificacion_humana: requiere
        };
    } catch (err) {
        console.error('OCR fallback activado:', err.message);
        ocrDisponible = false;
        return {
            ocr_exitoso: false,
            texto: '',
            votos: {},
            confianza: 0,
            observaciones: [`Fallo OCR: ${err.message}. Modo degradado activo.`],
            requiere_verificacion_humana: true
        };
    }
}

// ─── Auditoría ────────────────────────────────────────────────────────────────

async function registrarAuditoria({ acta_id, usuario, accion, datos_previos, datos_nuevos, ip }) {
    await dbRun(
        `INSERT INTO auditoria (acta_id, usuario, accion, datos_previos, datos_nuevos, ip)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            acta_id,
            usuario,
            accion,
            datos_previos ? JSON.stringify(datos_previos) : null,
            datos_nuevos ? JSON.stringify(datos_nuevos) : null,
            ip
        ]
    );
}

async function obtenerCapturas(actaId) {
    const rows = await dbAll(
        `SELECT id, acta_id, tipo, datos, timestamp
         FROM capturas WHERE acta_id = ? ORDER BY timestamp ASC`,
        [actaId]
    );
    return rows.map((row) => ({ ...row, datos: parseJsonField(row.datos, {}) }));
}

// ─── Inicialización de base de datos ─────────────────────────────────────────

async function initDatabase() {
    // Tabla principal de actas
    await dbRun(`CREATE TABLE IF NOT EXISTS actas (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        hash                        TEXT UNIQUE,
        imagen_path                 TEXT,
        metadata                    TEXT,
        datos_ocr                   TEXT,
        datos_corregidos            TEXT,
        ia_confianza                REAL,
        ia_observaciones            TEXT,
        captura_humana              TEXT,
        estado                      TEXT DEFAULT 'pendiente_humano',
        ocr_exitoso                 INTEGER DEFAULT 1,
        requiere_verificacion_humana INTEGER DEFAULT 0,
        created_at                  DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tabla de capturas individuales (ia / humano / supervisor)
    await dbRun(`CREATE TABLE IF NOT EXISTS capturas (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        acta_id   INTEGER,
        tipo      TEXT,    -- 'ia' | 'humano' | 'supervisor'
        datos     TEXT,    -- JSON string con votos
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(acta_id) REFERENCES actas(id)
    )`);

    // Tabla de auditoría
    await dbRun(`CREATE TABLE IF NOT EXISTS auditoria (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        acta_id      INTEGER,
        usuario      TEXT,
        accion       TEXT,
        datos_previos TEXT,
        datos_nuevos  TEXT,
        ip            TEXT,
        timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(acta_id) REFERENCES actas(id)
    )`);

    // Migraciones seguras: agrega columnas que podrían faltar en bases existentes
    const columnas = await dbAll(`PRAGMA table_info(actas)`);
    const nombres = columnas.map((c) => c.name);

    const migraciones = [
        ['estado', `ALTER TABLE actas ADD COLUMN estado TEXT DEFAULT 'pendiente_humano'`],
        ['ia_confianza', `ALTER TABLE actas ADD COLUMN ia_confianza REAL`],
        ['ia_observaciones', `ALTER TABLE actas ADD COLUMN ia_observaciones TEXT`],
        ['datos_corregidos', `ALTER TABLE actas ADD COLUMN datos_corregidos TEXT`],
        ['captura_humana', `ALTER TABLE actas ADD COLUMN captura_humana TEXT`],
        ['ocr_exitoso', `ALTER TABLE actas ADD COLUMN ocr_exitoso INTEGER DEFAULT 1`],
        ['requiere_verificacion_humana', `ALTER TABLE actas ADD COLUMN requiere_verificacion_humana INTEGER DEFAULT 0`],
    ];

    for (const [col, sql] of migraciones) {
        if (!nombres.includes(col)) {
            await dbRun(sql);
            console.log(`Migración aplicada: columna '${col}' agregada a actas`);
        }
    }

    // Migrar estado desde columna 'verificada' si existía
    if (!nombres.includes('estado') && nombres.includes('verificada')) {
        await dbRun(`UPDATE actas SET estado = 'verificada' WHERE verificada = 1`);
        await dbRun(`UPDATE actas SET estado = 'pendiente_humano' WHERE verificada = 0 OR verificada IS NULL`);
    }

    // Índices para mejorar rendimiento en consultas frecuentes
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_actas_estado   ON actas(estado)`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_actas_hash     ON actas(hash)`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_capturas_acta  ON capturas(acta_id)`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_auditoria_acta ON auditoria(acta_id)`);
}

// ════════════════════════════════════════════════════════════════════════════
// ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

// GET / — índice de la API
app.get('/', (req, res) => {
    res.json({
        nombre: 'ISIS Backend API',
        version: '2.0',
        frontend: 'http://localhost:5173',
        endpoints: {
            estadisticas: 'GET  /api/estadisticas',
            actas: 'GET  /api/actas[?estado=]',
            pendientes: 'GET  /api/actas/pendientes?tipo=humano|conflicto',
            subirActa: 'POST /api/actas',
            capturaHumana: 'POST /api/actas/:id/captura-humana',
            detalle: 'GET  /api/actas/:id/detalle',
            resolverConflicto: 'POST /api/actas/:id/resolver-conflicto',
            verificarPublica: 'GET  /api/actas/verificar-publica/:hash',
            auditoria: 'GET  /api/auditoria/:acta_id',
            health: 'GET  /api/health',
            seed: 'POST /api/seed',
        },
    });
});

// ─── POST /api/actas — subida de imagen + OCR + captura IA ───────────────────
app.post('/api/actas', upload.single('imagen'), async (req, res) => {
    const ip = getClientIp(req);
    const usuario = getUsuario(req);
    let imagenFile = req.file;

    try {
        if (!imagenFile) return res.status(400).json({ error: 'No se recibió archivo' });

        // Validar que el archivo no esté corrupto
        if (!validarIntegridadArchivo(imagenFile.path, imagenFile.mimetype)) {
            const corruptName = `corrupt_${Date.now()}_${imagenFile.originalname || 'archivo'}`;
            await moverACorruptas(imagenFile.path, corruptName);
            return res.status(422).json({
                error: 'Archivo corrupto o ilegible',
                requiere_verificacion_humana: true,
                sugerencia: 'Reintente la captura desde el CAEL'
            });
        }

        const metadata = JSON.parse(req.body.metadata || '{}');
        const hash = calcularHash(imagenFile.path);
        const ext = path.extname(imagenFile.originalname || '') ||
            (imagenFile.mimetype === 'application/pdf' ? '.pdf' : '.jpg');
        const imageName = `${hash.slice(0, 16)}${ext}`;
        const finalPath = path.join(__dirname, 'uploads', imageName);
        await fs.move(imagenFile.path, finalPath, { overwrite: true });
        imagenFile = { ...imagenFile, path: finalPath };

        // OCR con fallback: si falla, guarda acta igualmente con datos_ocr = null
        const ocr = await procesarOCR(finalPath, imagenFile.mimetype);
        const votosOCR = ocr.ocr_exitoso ? ocr.votos : null;

        const result = await dbRun(
            `INSERT INTO actas
             (hash, imagen_path, metadata, datos_ocr, ia_confianza, ia_observaciones,
              ocr_exitoso, requiere_verificacion_humana, estado)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente_humano')`,
            [
                hash,
                imageName,
                JSON.stringify(metadata),
                votosOCR ? JSON.stringify(votosOCR) : null,
                ocr.confianza,
                JSON.stringify(ocr.observaciones),
                ocr.ocr_exitoso ? 1 : 0,
                ocr.requiere_verificacion_humana ? 1 : 0,
            ]
        );

        const actaId = result.lastID;

        // Registrar captura IA en tabla capturas (aunque sea vacía, para trazabilidad)
        await dbRun(
            `INSERT INTO capturas (acta_id, tipo, datos) VALUES (?, 'ia', ?)`,
            [actaId, JSON.stringify(votosOCR ?? {})]
        );

        await registrarAuditoria({
            acta_id: actaId,
            usuario,
            accion: 'captura',
            datos_previos: null,
            datos_nuevos: { hash, metadata, ocr_exitoso: ocr.ocr_exitoso },
            ip
        });

        res.json({
            success: true,
            id: actaId,
            hash,
            ocr_sugerido: votosOCR,
            ocr_exitoso: ocr.ocr_exitoso,
            requiere_verificacion_humana: ocr.requiere_verificacion_humana,
            ia_confianza: ocr.confianza,
            ia_observaciones: ocr.observaciones,
            estado: 'pendiente_humano',
            imagen_url: `/uploads/${imageName}`,
            modo_degradado: !ocr.ocr_exitoso
        });
    } catch (err) {
        // Mover imagen a corruptas si el error no fue por duplicado
        if (imagenFile?.path && fs.existsSync(imagenFile.path)) {
            await moverACorruptas(imagenFile.path, `error_${Date.now()}`).catch(() => { });
        }
        if (err.message?.includes('UNIQUE')) {
            return res.status(409).json({ error: 'Esta imagen ya fue registrada (hash duplicado)' });
        }
        console.error('POST /api/actas error:', err);
        res.status(500).json({ error: err.message || 'Error interno del servidor' });
    }
});

// ─── GET /api/actas — listado con filtro opcional por estado ─────────────────
app.get('/api/actas', async (req, res) => {
    try {
        const { estado } = req.query;
        let sql = `SELECT id, hash, imagen_path, metadata, datos_ocr, datos_corregidos,
                          ia_confianza, ia_observaciones, ocr_exitoso, requiere_verificacion_humana,
                          estado, created_at FROM actas`;
        const params = [];
        if (estado) {
            sql += ` WHERE estado = ?`;
            params.push(estado);
        }
        sql += ` ORDER BY created_at DESC`;
        const rows = await dbAll(sql, params);
        res.json(rows.map(actaConUrls));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/actas/pendientes?tipo=humano|conflicto ─────────────────────────
app.get('/api/actas/pendientes', async (req, res) => {
    try {
        const { tipo } = req.query;
        let estado;
        if (tipo === 'humano') estado = 'pendiente_humano';
        else if (tipo === 'conflicto') estado = 'conflicto';
        else return res.status(400).json({ error: "Query 'tipo' debe ser 'humano' o 'conflicto'" });

        const rows = await dbAll(
            `SELECT id, hash, imagen_path, metadata, datos_ocr, ia_confianza, ia_observaciones,
                    ocr_exitoso, requiere_verificacion_humana, estado, created_at
             FROM actas WHERE estado = ? ORDER BY created_at ASC`,
            [estado]
        );
        res.json(rows.map(actaConUrls));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/actas/:id/captura-humana ──────────────────────────────────────
/**
 * Recibe los votos capturados por el operador humano y los compara con el OCR.
 * - Si coinciden exactamente → estado = 'verificada'
 * - Si difieren             → estado = 'conflicto'
 * Actualiza también la columna captura_humana en actas.
 */
app.post('/api/actas/:id/captura-humana', async (req, res) => {
    try {
        const { id } = req.params;
        const { datos } = req.body;

        if (!datos || typeof datos !== 'object') {
            return res.status(400).json({ error: 'Se requiere el objeto "datos"' });
        }

        const acta = await dbGet(`SELECT * FROM actas WHERE id = ?`, [id]);
        if (!acta) return res.status(404).json({ error: 'Acta no encontrada' });

        if (acta.estado !== 'pendiente_humano') {
            return res.status(409).json({
                error: 'Esta acta ya tiene una captura humana registrada',
                estado_actual: acta.estado
            });
        }

        const datosOCR = parseJsonField(acta.datos_ocr, {});
        const coinciden = datosIdenticos(datosOCR, datos);
        const nuevoEstado = coinciden ? 'verificada' : 'conflicto';

        // Guardar captura humana en tabla capturas
        await dbRun(
            `INSERT INTO capturas (acta_id, tipo, datos) VALUES (?, 'humano', ?)`,
            [id, JSON.stringify(datos)]
        );

        // Actualizar estado Y columna captura_humana en actas
        await dbRun(
            `UPDATE actas SET estado = ?, captura_humana = ? WHERE id = ?`,
            [nuevoEstado, JSON.stringify(datos), id]
        );

        await registrarAuditoria({
            acta_id: id,
            usuario: getUsuario(req),
            accion: 'verificacion',
            datos_previos: datosOCR,
            datos_nuevos: datos,
            ip: getClientIp(req)
        });

        res.json({
            success: true,
            estado: nuevoEstado,
            coinciden,
            mensaje: coinciden
                ? 'Captura humana coincide con OCR — acta verificada'
                : 'Captura humana difiere del OCR — conflicto registrado'
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/actas/:id/detalle ───────────────────────────────────────────────
app.get('/api/actas/:id/detalle', async (req, res) => {
    try {
        const { id } = req.params;
        const acta = await dbGet(`SELECT * FROM actas WHERE id = ?`, [id]);
        if (!acta) return res.status(404).json({ error: 'Acta no encontrada' });

        const capturas = await obtenerCapturas(id);
        res.json({ acta: actaConUrls(acta), capturas });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/actas/:id/resolver-conflicto ───────────────────────────────────
/**
 * Solo accesible si estado = 'conflicto'.
 * El supervisor proporciona los datos_finales definitivos.
 */
app.post('/api/actas/:id/resolver-conflicto', async (req, res) => {
    try {
        const { id } = req.params;
        const { datos_finales } = req.body;

        if (!datos_finales || typeof datos_finales !== 'object') {
            return res.status(400).json({ error: 'Se requiere el objeto "datos_finales"' });
        }

        const acta = await dbGet(`SELECT * FROM actas WHERE id = ?`, [id]);
        if (!acta) return res.status(404).json({ error: 'Acta no encontrada' });

        if (acta.estado !== 'conflicto') {
            return res.status(409).json({
                error: 'Solo se pueden resolver actas en estado conflicto',
                estado_actual: acta.estado
            });
        }

        await dbRun(
            `INSERT INTO capturas (acta_id, tipo, datos) VALUES (?, 'supervisor', ?)`,
            [id, JSON.stringify(datos_finales)]
        );

        await dbRun(
            `UPDATE actas SET estado = 'verificada', datos_corregidos = ? WHERE id = ?`,
            [JSON.stringify(datos_finales), id]
        );

        await registrarAuditoria({
            acta_id: id,
            usuario: getUsuario(req),
            accion: 'correccion',
            datos_previos: parseJsonField(acta.datos_ocr, {}),
            datos_nuevos: datos_finales,
            ip: getClientIp(req)
        });

        res.json({
            success: true,
            estado: 'verificada',
            datos_corregidos: datos_finales,
            mensaje: 'Conflicto resuelto por supervisor'
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/actas/verificar-publica/:hash — transparencia ciudadana ─────────
app.get('/api/actas/verificar-publica/:hash', async (req, res) => {
    try {
        const acta = await dbGet(`SELECT * FROM actas WHERE hash = ?`, [req.params.hash]);
        if (!acta) return res.status(404).json({ error: 'Acta no encontrada' });

        const capturas = await obtenerCapturas(acta.id);
        const publicCapturas = capturas.map((c) => ({
            tipo: c.tipo,
            datos: c.datos,
            timestamp: c.timestamp
        }));

        res.json({
            hash: acta.hash,
            estado: acta.estado,
            imagen_url: acta.imagen_path ? `/uploads/${acta.imagen_path}` : null,
            metadata: parseJsonField(acta.metadata, {}),
            ia_confianza: acta.ia_confianza,
            ia_observaciones: parseJsonField(acta.ia_observaciones, []),
            datos_ocr: parseJsonField(acta.datos_ocr, {}),
            datos_corregidos: parseJsonField(acta.datos_corregidos),
            ocr_exitoso: !!acta.ocr_exitoso,
            requiere_verificacion_humana: !!acta.requiere_verificacion_humana,
            created_at: acta.created_at,
            capturas: publicCapturas
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/estadisticas ────────────────────────────────────────────────────
app.get('/api/estadisticas', async (req, res) => {
    try {
        const row = await dbGet(`
            SELECT
                (SELECT COUNT(*) FROM actas)                              AS total,
                (SELECT COUNT(*) FROM actas WHERE estado = 'verificada') AS verificadas,
                (SELECT COUNT(*) FROM actas WHERE estado = 'pendiente_humano') AS pendientes_humano,
                (SELECT COUNT(*) FROM actas WHERE estado = 'conflicto') AS conflictos
        `);
        res.json(row);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/auditoria/:acta_id ──────────────────────────────────────────────
app.get('/api/auditoria/:acta_id', async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT id, acta_id, usuario, accion, datos_previos, datos_nuevos, ip, timestamp
             FROM auditoria WHERE acta_id = ? ORDER BY timestamp ASC`,
            [req.params.acta_id]
        );
        res.json(rows.map((r) => ({
            ...r,
            datos_previos: parseJsonField(r.datos_previos),
            datos_nuevos: parseJsonField(r.datos_nuevos)
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/health ─────────────────────────────────────────────────────────
/**
 * Semáforo del sistema: DB, OCR y espacio en disco.
 * disk_free se obtiene con `df` (disponible en Linux/macOS).
 */
app.get('/api/health', async (req, res) => {
    try {
        await dbGet('SELECT 1');

        // Espacio libre en disco donde viven los uploads (en bytes)
        let diskFreeBytes = null;
        try {
            const uploadsPath = path.join(__dirname, 'uploads');
            const dfOutput = execSync(`df -k "${uploadsPath}" | tail -1`).toString().trim();
            const parts = dfOutput.split(/\s+/);
            // df -k columna 3 = bloques disponibles (1K-blocks)
            diskFreeBytes = parseInt(parts[3], 10) * 1024;
        } catch {
            diskFreeBytes = null; // no disponible en este entorno
        }

        const diskOk = diskFreeBytes === null || diskFreeBytes > 100 * 1024 * 1024; // > 100 MB
        const estado = ocrDisponible && diskOk ? 'ok'
            : ocrDisponible || diskOk ? 'degradado'
                : 'critico';

        res.json({
            estado,
            db: 'ok',
            ocr: ocrDisponible ? 'ok' : 'degradado',
            almacenamiento: diskOk ? 'ok' : 'bajo',
            disk_free_bytes: diskFreeBytes,
            disk_free_mb: diskFreeBytes !== null ? Math.round(diskFreeBytes / (1024 * 1024)) : null,
            mensaje: estado === 'ok'
                ? 'Sistema operativo'
                : 'Modo degradado: verificación manual requerida en algunos casos'
        });
    } catch (err) {
        res.status(503).json({
            estado: 'critico',
            db: 'error',
            ocr: ocrDisponible ? 'ok' : 'degradado',
            mensaje: err.message
        });
    }
});

// ─── POST /api/seed — datos demo para hackathon ───────────────────────────────
app.post('/api/seed', async (req, res) => {
    try {
        const demos = [
            {
                hash: 'seed_chihuahua_' + Date.now(),
                metadata: { municipio: 'Chihuahua', seccion: '1234', tipo: 'Básica', numero: '1', lat: 28.6353, lng: -106.0889 },
                datos: { PAN: 245, PRI: 198, MORENA: 312, VERDE: 45, PT: 22, MC: 67, nulos: 12, no_registrados: 3, personas_votaron: 904 }
            },
            {
                hash: 'seed_juarez_' + Date.now(),
                metadata: { municipio: 'Juárez', seccion: '2156', tipo: 'Básica', numero: '3', lat: 31.6904, lng: -106.4245 },
                datos: { PAN: 412, PRI: 287, MORENA: 521, VERDE: 38, PT: 15, MC: 94, nulos: 8, no_registrados: 2, personas_votaron: 1377 }
            },
            {
                hash: 'seed_cuauhtemoc_' + Date.now(),
                metadata: { municipio: 'Cuauhtémoc', seccion: '0892', tipo: 'Contigua 1', numero: '2', lat: 28.4066, lng: -106.8653 },
                datos: { PAN: 178, PRI: 156, MORENA: 203, VERDE: 28, PT: 11, MC: 42, nulos: 5, no_registrados: 1, personas_votaron: 624 }
            }
        ];

        const insertados = [];
        for (const demo of demos) {
            const { confianza, observaciones } = validarActaIAConsistencia(demo.datos);
            const result = await dbRun(
                `INSERT INTO actas
                 (hash, imagen_path, metadata, datos_ocr, datos_corregidos,
                  ia_confianza, ia_observaciones, estado)
                 VALUES (?, '', ?, ?, ?, ?, ?, 'verificada')`,
                [
                    demo.hash,
                    JSON.stringify(demo.metadata),
                    JSON.stringify(demo.datos),
                    JSON.stringify(demo.datos),
                    confianza,
                    JSON.stringify(observaciones)
                ]
            );
            const actaId = result.lastID;
            await dbRun(`INSERT INTO capturas (acta_id, tipo, datos) VALUES (?, 'ia', ?)`, [actaId, JSON.stringify(demo.datos)]);
            await dbRun(`INSERT INTO capturas (acta_id, tipo, datos) VALUES (?, 'humano', ?)`, [actaId, JSON.stringify(demo.datos)]);
            insertados.push({ id: actaId, hash: demo.hash, municipio: demo.metadata.municipio });
        }

        res.json({ success: true, insertados: insertados.length, actas: insertados });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Middleware de errores de multer ──────────────────────────────────────────
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message?.includes('Solo JPG')) {
        return res.status(400).json({ error: err.message });
    }
    next(err);
});

// ─── Arranque ─────────────────────────────────────────────────────────────────
initDatabase()
    .then(() => {
        app.listen(3000, () => console.log('ISIS Backend en http://localhost:3000'));
    })
    .catch((err) => {
        console.error('Error al inicializar la base de datos:', err);
        process.exit(1);
    });