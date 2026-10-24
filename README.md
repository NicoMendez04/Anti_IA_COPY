# Vigía

MVP de sesiones de evaluación digital con supervisión en tiempo real.

## Arranque

En una terminal:

```bash
cd backend
npm install
npm run dev
```

En otra terminal:

```bash
cd frontend
npm install
npm run dev
```

Abre `http://localhost:5173`. Las sesiones viven en memoria y se eliminan al reiniciar el backend.

## Configuración local

Los archivos `.env` y `.env.local` son locales y no se suben a GitHub. Para preparar el entorno:

```powershell
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env.local
```

Si usas un túnel, reemplaza las URLs de esos archivos por las URLs públicas del backend y frontend.

## GitHub

Desde la raíz del proyecto:

```powershell
git init
git add .
git status
git commit -m "Inicializa MVP de sesiones de evaluacion"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPOSITORIO.git
git push -u origin main
```

No incluyas archivos `.env`, `node_modules` ni `frontend/dist` en el repositorio. Configura sus variables equivalentes directamente en Render, GitHub Actions o el servicio de despliegue que utilices.

## Despliegue público en Render

El archivo `render.yaml` prepara dos servicios: uno para la API Node.js y otro para el frontend estático. Para publicarlo:

1. Sube este proyecto a un repositorio de GitHub.
2. En Render selecciona **New > Blueprint** y conecta ese repositorio.
3. Render leerá `render.yaml` y creará `vigia-api` y `vigia-web`.
4. Si Render asigna nombres distintos, actualiza `PUBLIC_APP_URL`, `FRONTEND_URL` y `VITE_API_URL` con las URLs reales y vuelve a desplegar.

El backend usa memoria temporal: las sesiones activas se pierden si el servicio se reinicia. El plan gratuito de Render puede dormir después de un periodo sin tráfico, por lo que conviene usarlo para pruebas y sesiones cortas.

## Monitoreo de evaluaciones

El navegador solo observa que la página se ocultó o volvió; no puede saber si el alumno desbloqueó el teléfono ni qué app usó. Por eso:

- Ocultar la página (también el bloqueo previo al inicio) se registra como señal técnica y nunca es falta.
- Un retorno durante la evaluación abre una **incidencia a revisar** (`Retorno detectado, revisar`); visible + foco del mismo retorno se consolidan en una sola.
- Solo el profesor confirma o descarta la incidencia. Confirmarla suma una falta y, al llegar al límite, expulsa.
- Los eventos llevan `eventId`, `tabInstanceId` y `sequenceNumber`; el servidor descarta reenvíos y eventos desordenados.

Pruebas automáticas: `cd backend && npm test`.

Checklist manual (Chrome Android, Safari iPhone, escritorio):
1. Registrarse, bloquear antes de iniciar y esperar: sin incidencias.
2. El profesor inicia con el teléfono bloqueado: la sesión pasa a activa.
3. Desbloquear y volver a la web: una sola incidencia pendiente.
4. Cambiar de app y volver, llamada entrante, recarga y cierre/reapertura: sin incidencias duplicadas.
5. Cambio de red con la página visible: sin incidencia.
6. Descartar y confirmar desde el panel; la falta confirmada suma un aviso al alumno.
7. Usar otra app sin volver a la web no se detecta (limitación del navegador).
