# three.js — vendored copy

Версия: 0.160.0 (та же, что раньше была закреплена в CDN-importmap).

Локальная копия вместо CDN (cdn.jsdelivr.net) — система может
разворачиваться в сетях без доступа к внешним CDN (закрытый контур,
корпоративный прокси с ограничениями). Содержит только то, что реально
используется в public/index.html:

- build/three.module.js
- examples/jsm/controls/OrbitControls.js
- examples/jsm/renderers/CSS2DRenderer.js
- examples/jsm/utils/BufferGeometryUtils.js

Обновление версии: `npm install three@<версия>` во временной папке,
скопировать эти же 4 файла (+ LICENSE) поверх, поправить версию тут.
