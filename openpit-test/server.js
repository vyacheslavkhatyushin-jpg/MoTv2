/*
open-pit-test — изолированный MVP-спайк проверки концепции открытых
карьеров (CesiumJS). НЕ связан с основным приложением MoTv2: свой сервер,
своя память как "БД" (нет постоянного хранилища кроме файлов на диске),
ничего из server/ или public/ не импортирует и не трогает. Одна текущая
поверхность на весь инстанс (не multi-project, не multi-user) — этого
достаточно, чтобы руками проверить пайплайн загрузки на реальных данных.

Пайплайн:
  .csv (semicolon-separated "lat;lon;height", запятая как десятичный
        разделитель — формат маркшейдерских as-built выгрузок) →
        Delaunay-триангуляция (delaunator) + фильтр аномально длинных
        рёбер → JSON {points, indices}, отдаётся клиенту, который сам
        строит Cesium.Geometry/Primitive.
  .dxf  → assimp (должен быть установлен в системе, см. Dockerfile) →
        .glb, отдаётся клиенту как обычный статический файл, грузится
        через Cesium.Model.fromGltfAsync.
*/
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import Delaunator from "delaunator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const PORT = process.env.OPENPIT_TEST_PORT || 3100;
const BASE_PATH = "/open-pit-test";

const app = express();
const router = express.Router();

const upload = multer({ dest: path.join(DATA_DIR, "tmp"), limits: { fileSize: 500 * 1024 * 1024 } });

// Триангуляция в 2D по (lon,lat) — площадь участка съёмки мала, проекцией
// пренебрегаем; height просто атрибут вершины. EDGE_LIMIT отсекает
// треугольники, которые Delaunay достраивает через пустые области (там,
// где точек в принципе нет) — грубая эвристика в градусах, ~150м на
// широте 52°. При необходимости для других месторождений/масштабов
// подбирается заново.
const EDGE_LIMIT = 0.0015;

function parseCsvToPoints(text) {
  const points = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(";");
    if (parts.length !== 3) continue;
    const lat = parseFloat(parts[0].replace(",", "."));
    const lon = parseFloat(parts[1].replace(",", "."));
    const h = parseFloat(parts[2].replace(",", "."));
    if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(h)) points.push([lon, lat, h]);
  }
  return points;
}

function triangulate(points) {
  const coords = new Float64Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    coords[i * 2] = points[i][0];
    coords[i * 2 + 1] = points[i][1];
  }
  const delaunay = new Delaunator(coords);
  const triangles = delaunay.triangles;
  const limit2 = EDGE_LIMIT * EDGE_LIMIT;
  function dist2(iA, iB) {
    const dx = points[iA][0] - points[iB][0];
    const dy = points[iA][1] - points[iB][1];
    return dx * dx + dy * dy;
  }
  const indices = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2];
    if (dist2(a, b) > limit2 || dist2(b, c) > limit2 || dist2(a, c) > limit2) continue;
    indices.push(a, b, c);
  }
  return indices;
}

// Метаданные текущей поверхности — в памяти процесса, осознанно: это
// экспериментальный однопользовательский инструмент, не продакшен-сервис.
let currentSurface = null; // { format: "mesh"|"glb", uploadedAt, sourceName, file }

router.get("/api/surface", (req, res) => {
  res.json({ surface: currentSurface });
});

router.get("/api/surface/file", (req, res) => {
  if (!currentSurface) return res.status(404).json({ error: "no_surface" });
  res.sendFile(path.join(DATA_DIR, currentSurface.file));
});

router.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no_file" });
  const ext = path.extname(req.file.originalname).toLowerCase();
  try {
    if (ext === ".csv") {
      const text = fs.readFileSync(req.file.path, "utf8");
      const points = parseCsvToPoints(text);
      if (!points.length) throw new Error("Не нашёл ни одной валидной строки (ожидается lat;lon;height, запятая как десятичный разделитель)");
      const indices = triangulate(points);
      const outName = `surface-${Date.now()}.json`;
      fs.writeFileSync(path.join(DATA_DIR, outName), JSON.stringify({ points, indices }));
      currentSurface = {
        format: "mesh", file: outName, sourceName: req.file.originalname,
        uploadedAt: new Date().toISOString(), pointCount: points.length, triangleCount: indices.length / 3,
      };
      res.json({ surface: currentSurface });
    } else if (ext === ".dxf") {
      const outName = `surface-${Date.now()}.glb`;
      const outPath = path.join(DATA_DIR, outName);
      await new Promise((resolve, reject) => {
        execFile("assimp", ["export", req.file.path, outPath], { timeout: 120000 }, (err, stdout, stderr) => {
          if (err) return reject(new Error("assimp: " + (stderr || err.message)));
          resolve();
        });
      });
      currentSurface = {
        format: "glb", file: outName, sourceName: req.file.originalname, uploadedAt: new Date().toISOString(),
      };
      res.json({ surface: currentSurface });
    } else {
      return res.status(400).json({ error: "unsupported_format", message: "Поддерживаются только .csv и .dxf" });
    }
  } catch (e) {
    res.status(500).json({ error: "processing_failed", message: e.message });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

router.use(express.static(path.join(__dirname, "public")));

app.use(BASE_PATH, router);
app.get("/", (req, res) => res.redirect(BASE_PATH + "/"));

app.listen(PORT, () => {
  console.log(`open-pit-test listening on port ${PORT}, mounted at ${BASE_PATH}`);
});
