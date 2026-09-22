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

// Лёгкий разбор .glb без сторонних библиотек — чтобы показать в UI реальное
// число вершин/треугольников/bbox для DXF-пути так же, как для CSV
// (pointCount/triangleCount). Без этого "Готово" означало только то, что
// assimp завершился с кодом 0 — а он может завершиться успешно, но не
// извлечь ни одной грани (например, если поверхность в DXF задана не
// 3DFACE, а POLYLINE/polyface mesh, которые эта сборка assimp не
// поддерживает) — тогда получится пустой, но "успешный" .glb.
// GLB: 12-байтный заголовок (magic/version/length), затем чанки —
// первый всегда JSON (сам glTF-документ), из его accessors[].min/max по
// POSITION-атрибуту берём bbox без похода в бинарный BIN-чанк вообще.
// Реальные as-built DXF со съёмки часто тащат "мусорные" точки далеко за
// пределами самой поверхности — рамки штампа, текстовые подписи, точки
// привязки блоков (INSERT) в (0,0) при том, что сама съёмка в UTM-числах
// порядка 10^5-10^6. Один такой выброс раздувает bbox/boundingSphere так,
// что при центрировании и наведении камеры по НЕМУ реальная поверхность
// сжимается в несколько пикселей — визуально "пусто", хотя данные на
// месте. percentile() отрезает по 1% с каждого края на каждой оси —
// грубый, но дешёвый способ игнорировать одиночные выбросы.
function percentile(sortedArr, p) {
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.round(p * (sortedArr.length - 1))));
  return sortedArr[idx];
}

function inspectGlb(buffer) {
  if (buffer.length < 20 || buffer.toString("ascii", 0, 4) !== "glTF") {
    throw new Error("Не похоже на валидный .glb (нет magic-заголовка)");
  }
  const jsonChunkLength = buffer.readUInt32LE(12);
  const jsonChunkType = buffer.toString("ascii", 16, 20);
  if (jsonChunkType !== "JSON") throw new Error("Первый чанк .glb — не JSON");
  const json = JSON.parse(buffer.toString("utf8", 20, 20 + jsonChunkLength));

  // Следующий чанк после JSON — бинарный буфер (BIN), там лежат реальные
  // координаты вершин, которые нужны для честного перцентильного bbox
  // (accessors[].min/max — это как раз тот самый "заражённый" выбросами
  // истинный минимум/максимум, который мы хотим перепроверить).
  const binChunkOffset = 20 + jsonChunkLength;
  let binData = null;
  if (binChunkOffset < buffer.length) {
    const binChunkLength = buffer.readUInt32LE(binChunkOffset);
    const binChunkType = buffer.toString("ascii", binChunkOffset + 4, binChunkOffset + 8);
    if (binChunkType.startsWith("BIN")) binData = buffer.subarray(binChunkOffset + 8, binChunkOffset + 8 + binChunkLength);
  }

  const meshes = json.meshes || [];
  const accessors = json.accessors || [];
  const bufferViews = json.bufferViews || [];
  let primitiveCount = 0, vertexCount = 0, triangleCount = 0;
  let bboxMin = null, bboxMax = null;
  const xs = [], ys = [], zs = [];
  for (const mesh of meshes) {
    for (const prim of mesh.primitives || []) {
      primitiveCount++;
      const posAcc = accessors[prim.attributes && prim.attributes.POSITION];
      if (posAcc) {
        vertexCount += posAcc.count || 0;
        // Bbox всегда считаем из реальных данных в BIN, а не из
        // accessor.min/max — тот заполняет только assimp (и не всегда:
        // наш собственный filterGlbOutliers() его не пишет вовсе), так
        // что полагаться на него ненадёжно.
        if (binData && posAcc.componentType === 5126 /* FLOAT */ && posAcc.bufferView != null) {
          const bv = bufferViews[posAcc.bufferView];
          const start = (bv.byteOffset || 0) + (posAcc.byteOffset || 0);
          for (let i = 0; i < posAcc.count; i++) {
            const o = start + i * 12;
            const x = binData.readFloatLE(o), y = binData.readFloatLE(o + 4), z = binData.readFloatLE(o + 8);
            xs.push(x); ys.push(y); zs.push(z);
            bboxMin = bboxMin ? [Math.min(bboxMin[0], x), Math.min(bboxMin[1], y), Math.min(bboxMin[2], z)] : [x, y, z];
            bboxMax = bboxMax ? [Math.max(bboxMax[0], x), Math.max(bboxMax[1], y), Math.max(bboxMax[2], z)] : [x, y, z];
          }
        }
      }
      const idxAcc = accessors[prim.indices];
      if (idxAcc) triangleCount += Math.floor((idxAcc.count || 0) / 3);
      else if (posAcc) triangleCount += Math.floor((posAcc.count || 0) / 3); // без indices — плоский triangle list
    }
  }

  let robustBboxMin = bboxMin, robustBboxMax = bboxMax, outliersTrimmed = false;
  if (xs.length > 20) {
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b); zs.sort((a, b) => a - b);
    robustBboxMin = [percentile(xs, 0.01), percentile(ys, 0.01), percentile(zs, 0.01)];
    robustBboxMax = [percentile(xs, 0.99), percentile(ys, 0.99), percentile(zs, 0.99)];
    // Если 1%-99% диапазон заметно (>2x) меньше полного — почти наверняка
    // выбросы, а не просто плотное облако точек до самых краёв.
    const fullSpan = bboxMax.map((v, i) => v - bboxMin[i]);
    const robustSpan = robustBboxMax.map((v, i) => v - robustBboxMin[i]);
    outliersTrimmed = fullSpan.some((v, i) => v > robustSpan[i] * 2 + 1e-6);
  }

  return { meshCount: meshes.length, primitiveCount, vertexCount, triangleCount, bboxMin, bboxMax, robustBboxMin, robustBboxMax, outliersTrimmed };
}

// Пытаться на клиенте отдельно вычислить "где на самом деле центр
// поверхности без выбросов" и навести туда камеру — тупик: у Cesium
// поверх нашего modelMatrix есть ещё узловая матрица из glTF (assimp
// пишет Z-up→Y-up конверсию) и, возможно, собственная коррекция осей —
// самостоятельно построенный BoundingSphere с координатами, "как они
// должны быть", стабильно не совпадает с тем, где Cesium модель реально
// рисует (эмпирически проверено: числа выглядят разумно, экран пустой).
// Единственный надёжный способ — не гадать о системе координат вообще, а
// вырезать выбросы из самой геометрии: тогда model.boundingSphere,
// который Cesium считает сам из оставшихся вершин, автоматически
// оказывается правильным — камере некуда "поехать не туда".
// Оставляем только треугольники, ВСЕ три вершины которых внутри
// перцентильного bbox, и только triangle-list примитивы (mode 4) —
// нетреугольные примитивы (LINE и т.п.) для поверхности не нужны и часто
// сами являются источником выбросов (рамки, выноски).
function filterGlbOutliers(buffer, robustBboxMin, robustBboxMax) {
  const jsonChunkLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.toString("utf8", 20, 20 + jsonChunkLength));
  const binChunkOffset = 20 + jsonChunkLength;
  const binChunkLength = buffer.readUInt32LE(binChunkOffset);
  const binData = buffer.subarray(binChunkOffset + 8, binChunkOffset + 8 + binChunkLength);

  const accessors = json.accessors || [];
  const bufferViews = json.bufferViews || [];
  const inRange = (x, y, z) =>
    x >= robustBboxMin[0] && x <= robustBboxMax[0] &&
    y >= robustBboxMin[1] && y <= robustBboxMax[1] &&
    z >= robustBboxMin[2] && z <= robustBboxMax[2];

  const outPositions = [];
  const outColors = [];
  const outMeshes = [];

  for (const mesh of json.meshes || []) {
    const keptPrimitives = [];
    for (const prim of mesh.primitives || []) {
      if (prim.mode !== 4 && prim.mode !== undefined) continue; // не triangle-list — пропускаем
      const posAcc = accessors[prim.attributes && prim.attributes.POSITION];
      const idxAcc = accessors[prim.indices];
      const colAcc = prim.attributes && prim.attributes.COLOR_0 != null ? accessors[prim.attributes.COLOR_0] : null;
      if (!posAcc || posAcc.componentType !== 5126) continue;
      const posBv = bufferViews[posAcc.bufferView];
      const posStart = (posBv.byteOffset || 0) + (posAcc.byteOffset || 0);
      const readPos = (i) => [
        binData.readFloatLE(posStart + i * 12), binData.readFloatLE(posStart + i * 12 + 4), binData.readFloatLE(posStart + i * 12 + 8),
      ];
      let colStart = null;
      if (colAcc) { const cbv = bufferViews[colAcc.bufferView]; colStart = (cbv.byteOffset || 0) + (colAcc.byteOffset || 0); }
      const readCol = (i) => colStart == null ? [0.9, 0.9, 0.9, 1] : [
        binData.readFloatLE(colStart + i * 16), binData.readFloatLE(colStart + i * 16 + 4),
        binData.readFloatLE(colStart + i * 16 + 8), binData.readFloatLE(colStart + i * 16 + 12),
      ];
      const readIdx = (i) => {
        if (!idxAcc) return i;
        const ibv = bufferViews[idxAcc.bufferView];
        const start = (ibv.byteOffset || 0) + (idxAcc.byteOffset || 0);
        if (idxAcc.componentType === 5125) return binData.readUInt32LE(start + i * 4);
        if (idxAcc.componentType === 5123) return binData.readUInt16LE(start + i * 2);
        return binData.readUInt8(start + i);
      };
      const indexCount = idxAcc ? idxAcc.count : posAcc.count;

      const remap = new Map();
      const newIndices = [];
      let pMin = null, pMax = null;
      for (let t = 0; t < indexCount; t += 3) {
        const i0 = readIdx(t), i1 = readIdx(t + 1), i2 = readIdx(t + 2);
        const p0 = readPos(i0), p1 = readPos(i1), p2 = readPos(i2);
        if (!inRange(...p0) || !inRange(...p1) || !inRange(...p2)) continue;
        for (const oldIdx of [i0, i1, i2]) {
          if (!remap.has(oldIdx)) {
            remap.set(oldIdx, outPositions.length / 3);
            const p = readPos(oldIdx);
            outPositions.push(p[0], p[1], p[2]);
            outColors.push(...readCol(oldIdx));
            pMin = pMin ? [Math.min(pMin[0], p[0]), Math.min(pMin[1], p[1]), Math.min(pMin[2], p[2])] : p.slice();
            pMax = pMax ? [Math.max(pMax[0], p[0]), Math.max(pMax[1], p[1]), Math.max(pMax[2], p[2])] : p.slice();
          }
          newIndices.push(remap.get(oldIdx));
        }
      }
      if (!newIndices.length) continue;
      keptPrimitives.push({
        indices: newIndices, vertexOffset: outPositions.length / 3 - remap.size, vertexCount: remap.size,
        material: prim.material, min: pMin, max: pMax,
      });
    }
    if (keptPrimitives.length) outMeshes.push(keptPrimitives);
  }

  if (!outPositions.length) return null; // после фильтрации ничего не осталось

  // Собираем новый GLB "с нуля" — один POSITION+COLOR_0 буфер на все
  // сохранённые вершины (примитивы адресуют свой диапазон через
  // byteOffset), плюс один индексный accessor на примитив.
  const posBuf = Buffer.alloc(outPositions.length * 4);
  for (let i = 0; i < outPositions.length; i++) posBuf.writeFloatLE(outPositions[i], i * 4);
  const colBuf = Buffer.alloc(outColors.length * 4);
  for (let i = 0; i < outColors.length; i++) colBuf.writeFloatLE(outColors[i], i * 4);

  const newAccessors = [];
  const newBufferViews = [];
  const newMeshes = [];
  const idxBuffers = [];

  const posBvIdx = newBufferViews.push({ buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 }) - 1;
  const colBvIdx = newBufferViews.push({ buffer: 0, byteOffset: posBuf.length, byteLength: colBuf.length, target: 34962 }) - 1;
  let cursor = posBuf.length + colBuf.length;

  for (const prims of outMeshes) {
    const newPrims = [];
    for (const p of prims) {
      const idxBuf = Buffer.alloc(p.indices.length * 4);
      for (let i = 0; i < p.indices.length; i++) idxBuf.writeUInt32LE(p.indices[i], i * 4);
      idxBuffers.push(idxBuf);
      const idxBvIdx = newBufferViews.push({ buffer: 0, byteOffset: cursor, byteLength: idxBuf.length, target: 34963 }) - 1;
      cursor += idxBuf.length;

      const posAccIdx = newAccessors.push({
        bufferView: posBvIdx, byteOffset: p.vertexOffset * 12, componentType: 5126, count: p.vertexCount, type: "VEC3",
        min: p.min, max: p.max, // обязательны по спеку glTF для POSITION, и Cesium сам на них опирается (BoundingSphere.fromCornerPoints)
      }) - 1;
      const colAccIdx = newAccessors.push({
        bufferView: colBvIdx, byteOffset: p.vertexOffset * 16, componentType: 5126, count: p.vertexCount, type: "VEC4",
      }) - 1;
      const idxAccIdx = newAccessors.push({
        bufferView: idxBvIdx, componentType: 5125, count: p.indices.length, type: "SCALAR",
      }) - 1;
      newPrims.push({ mode: 4, material: p.material, indices: idxAccIdx, attributes: { POSITION: posAccIdx, COLOR_0: colAccIdx } });
    }
    newMeshes.push({ primitives: newPrims });
  }

  const binOut = Buffer.concat([posBuf, colBuf, ...idxBuffers]);
  const newJson = {
    asset: json.asset || { version: "2.0" },
    materials: json.materials,
    accessors: newAccessors,
    bufferViews: newBufferViews,
    buffers: [{ byteLength: binOut.length }],
    meshes: newMeshes,
    nodes: newMeshes.map((_, i) => ({ mesh: i })),
    scenes: [{ nodes: newMeshes.map((_, i) => i) }],
    scene: 0,
  };

  const jsonStr = JSON.stringify(newJson);
  const jsonPadded = Buffer.from(jsonStr + " ".repeat((4 - (jsonStr.length % 4)) % 4));
  const binPadded = binOut.length % 4 === 0 ? binOut : Buffer.concat([binOut, Buffer.alloc(4 - (binOut.length % 4))]);

  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii"); header.writeUInt32LE(2, 4);
  const totalLength = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  header.writeUInt32LE(totalLength, 8);

  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(jsonPadded.length, 0); jsonChunkHeader.write("JSON", 4, "ascii");
  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(binPadded.length, 0); binChunkHeader.write("BIN\0", 4, "ascii");

  return Buffer.concat([header, jsonChunkHeader, jsonPadded, binChunkHeader, binPadded]);
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
      let glbBuffer = fs.readFileSync(outPath);
      let glbStats = inspectGlb(glbBuffer);
      if (glbStats.outliersTrimmed) {
        const filtered = filterGlbOutliers(glbBuffer, glbStats.robustBboxMin, glbStats.robustBboxMax);
        if (filtered) {
          fs.writeFileSync(outPath, filtered);
          glbStats = inspectGlb(filtered);
        }
      }
      currentSurface = {
        format: "glb", file: outName, sourceName: req.file.originalname, uploadedAt: new Date().toISOString(),
        ...glbStats,
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
