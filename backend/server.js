const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs-extra');
const crypto = require('crypto');
const tesseract = require('tesseract.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Servir la carpeta 'uploads' para que las imágenes sean accesibles desde el navegador
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Asegurar que la carpeta 'uploads' existe
fs.ensureDirSync('uploads');

// Configuración de subida de imágenes
const upload = multer({ dest: 'uploads/' });

// Base de datos SQLite
const db = new sqlite3.Database('database.sqlite');
db.run(`CREATE TABLE IF NOT EXISTS actas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT UNIQUE,
  imagen_path TEXT,
  metadata TEXT,
  datos_ocr TEXT,
  datos_corregidos TEXT,
  verificada INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Función hash SHA-256
function calcularHash(filePath) {
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Función para extraer números del texto OCR
function extraerVotos(texto) {
    const numeros = texto.match(/\b\d{2,4}\b/g) || [];
    const partidos = ['PAN', 'PRI', 'MORENA', 'VERDE', 'PT', 'MC'];
    let votos = {};
    for (let i = 0; i < partidos.length && i < numeros.length; i++) {
        votos[partidos[i]] = parseInt(numeros[i]);
    }
    const totalMatch = texto.match(/total[^\d]*(\d+)/i);
    votos['personas_votaron'] = totalMatch ? parseInt(totalMatch[1]) : 0;
    return votos;
}

// Endpoint para recibir acta
app.post('/api/actas', upload.single('imagen'), async (req, res) => {
    try {
        const imagenFile = req.file;
        const metadata = JSON.parse(req.body.metadata);
        if (!imagenFile) return res.status(400).json({ error: 'No image' });

        const hash = calcularHash(imagenFile.path);
        // Guardar solo el nombre del archivo (para construir la URL después)
        const imageName = path.basename(imagenFile.path);

        // OCR
        const { data: { text } } = await tesseract.recognize(imagenFile.path, 'spa');
        const votosOCR = extraerVotos(text);

        // Guardar en DB
        db.run(`INSERT INTO actas (hash, imagen_path, metadata, datos_ocr) VALUES (?, ?, ?, ?)`,
            [hash, imageName, JSON.stringify(metadata), JSON.stringify(votosOCR)],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, hash, ocr_sugerido: votosOCR, imagen_url: `/uploads/${imageName}` });
            }
        );
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Endpoint para obtener actas pendientes (incluyendo imagen_path)
app.get('/api/actas/pendientes', (req, res) => {
    db.all(`SELECT id, hash, imagen_path, metadata, datos_ocr, created_at FROM actas WHERE verificada = 0`, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // Opcional: agregar URL completa de la imagen
        const rowsWithUrl = rows.map(row => ({
            ...row,
            imagen_url: `/uploads/${row.imagen_path}`
        }));
        res.json(rowsWithUrl);
    });
});

// Endpoint para verificar acta
app.put('/api/actas/:id/verificar', (req, res) => {
    const { id } = req.params;
    const { datos_corregidos } = req.body;
    db.run(`UPDATE actas SET datos_corregidos = ?, verificada = 1 WHERE id = ?`,
        [JSON.stringify(datos_corregidos), id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

// Endpoint de estadísticas
app.get('/api/estadisticas', (req, res) => {
    db.get(`SELECT 
        (SELECT COUNT(*) FROM actas) AS total,
        (SELECT COUNT(*) FROM actas WHERE verificada = 1) AS verificadas,
        (SELECT COUNT(*) FROM actas WHERE verificada = 0) AS pendientes`, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row);
    });
});

app.listen(3000, () => console.log('Backend en http://localhost:3000'));