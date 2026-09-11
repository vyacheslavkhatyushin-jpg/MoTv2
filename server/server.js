const path = require("path");
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const projectRoutes = require("./routes/projects");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// Snapshots embed parsed STR/DTM geometry and can be large.
app.use(express.json({ limit: "300mb" }));

app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);

app.use(express.static(path.join(__dirname, "..", "public")));

// SPA: any other GET (e.g. /:projectId) serves the app; the frontend reads
// the project id from the URL path itself.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Mine Operations Tool server listening on port ${PORT}`);
});
