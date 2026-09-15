/*
Совместимость: раньше был отдельный скрипт только для меток, теперь это
частный случай list-objects.js (работает так же для cables/equipment/
marks/patches). Оставлен как есть, чтобы не менять уже привычную команду.

Usage:
  node list-marks.js <projectId> [labelSubstring]
*/
const [, , projectId, labelSubstring] = process.argv;
process.argv = [process.argv[0], process.argv[1], projectId, "marks", labelSubstring];
require("./list-objects.js");
