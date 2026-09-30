# Pruebas

- `personas.json`: dueños de negocio inventados, tomados del harness de la clase 1. Hacen de
  cliente para probar el motor sin usar clientes reales.
- `privadas/`: material real (chats, guiones, precios) para simular a un cliente antes de
  mandarle el link. Git la ignora: el repositorio es público y no puede entrar nada de ahí.
- `zip-de-prueba.ts`: arma en memoria los .zip y las cabeceras de foto, audio, video y PDF que
  usan `archivos.test.ts` y `proceso.test.ts`. Todo inventado: ningún archivo de un cliente entra
  al repositorio, ni siquiera como muestra.
- `multimedia.test.ts` genera sus audios y videos con ffmpeg y usa un transcriptor falso. Sin
  ffmpeg (en el PATH o en `RUTA_FFMPEG`) esas pruebas se saltean y el resto corre igual.
