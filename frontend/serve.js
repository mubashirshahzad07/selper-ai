// frontend/serve.js
// A minimal static file server with zero dependencies — the frontend is
// plain HTML/CSS/JS, so it doesn't need a build step or a framework's dev
// server, just something to serve the files and set the right content-type.
// Run: node serve.js  (defaults to http://localhost:8080)

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
    try {
        const urlPath = decodeURIComponent(req.url.split("?")[0]);
        let filePath = path.join(__dirname, urlPath === "/" ? "/index.html" : urlPath);

        // Guard against path traversal outside the frontend directory.
        if (!filePath.startsWith(__dirname)) {
            res.writeHead(403);
            return res.end("Forbidden");
        }

        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (!stat || stat.isDirectory()) {
            res.writeHead(404);
            return res.end("Not found");
        }

        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        res.writeHead(500);
        res.end("Server error");
    }
});

server.listen(PORT, () => {
    console.log(`Study Helper frontend running at http://localhost:${PORT}`);
});
