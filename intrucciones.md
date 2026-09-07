# Sistema de Pruebas Digitales Anti-Fraude con QR

## 📌 Descripción General
Aplicación web que permite a un profesor/administrador crear sesiones de prueba o examen. Los estudiantes escanean un código QR desde una app web, se registran con su nombre, y quedan bajo supervisión. La app bloquea la pantalla del estudiante, monitorea su actividad, envía alertas si abandona la sesión o intenta copiar, y el profesor ve en tiempo real quién está conectado.

---

## 🎯 Requisitos Funcionales

### A. Panel Profesor/Admin
- [ ] Crear nueva sesión de examen/prueba
- [ ] Generar código QR dinámico
- [ ] Mostrar lista de estudiantes conectados en tiempo real
- [ ] Recibir alertas cuando un estudiante:
  - Se sale de la app (pierde foco de ventana)
  - Intenta abrir otra pestaña/ventana
  - Intenta ir atrás/recargar
  - Cambia de app en móvil
- [ ] Ver historial de alertas durante la sesión
- [ ] Finalizar sesión manualmente
- [ ] Opción para "expulsar" a un estudiante de la sesión

### B. App Estudiante
- [ ] Página de inicio con QR scanner
- [ ] Escanear QR y conectar a la sesión
- [ ] Pantalla de ingreso de nombre
- [ ] Pantalla bloqueada (full screen, sin controles)
- [ ] Mostrar lista de compañeros conectados
- [ ] Detectar y alertar sobre:
  - Pérdida de foco de ventana
  - Intento de cambiar de pestaña
  - Intento de cerrar sesión
  - Intento de abrir DevTools
  - Cambio de app en móvil
- [ ] Mostrar contador de tiempo en sesión
- [ ] Recibir notificación si el profesor lo expulsa

### C. Backend
- [ ] Generar QR únicos por sesión
- [ ] Gestionar sesiones activas
- [ ] Comunicación en tiempo real vía WebSocket (Socket.io)
- [ ] Registrar eventos de cada estudiante
- [ ] Endpoint para crear sesión
- [ ] Endpoint para finalizar sesión
- [ ] Endpoint para expulsar estudiante

---

## 🏗️ Arquitectura Técnica

### Stack Tecnológico
- **Frontend**: React 18 + Vite
- **Backend**: Node.js + Express.js
- **Comunicación Real-time**: Socket.io
- **QR Scanner**: html5-qrcode
- **QR Generation**: qrcode.react
- **Almacenamiento**: En memoria (sesión temporal)

### Estructura de Carpetas
```
proyecto-examen/
├── backend/
│   ├── server.js
│   ├── package.json
│   ├── routes/
│   │   ├── sessions.js
│   │   └── exams.js
│   ├── controllers/
│   │   └── sessionController.js
│   ├── models/
│   │   ├── Session.js
│   │   └── Student.js
│   └── utils/
│       └── qrGenerator.js
├── frontend/
│   ├── package.json
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx
│   │   ├── pages/
│   │   │   ├── ProfessorDashboard.jsx
│   │   │   ├── StudentScanner.jsx
│   │   │   ├── StudentSession.jsx
│   │   │   └── AdminLogin.jsx
│   │   ├── components/
│   │   │   ├── QRScanner.jsx
│   │   │   ├── StudentsList.jsx
│   │   │   ├── AlertsPanel.jsx
│   │   │   └── QRDisplay.jsx
│   │   ├── hooks/
│   │   │   ├── useSocket.js
│   │   │   └── useScreenLock.js
│   │   ├── utils/
│   │   │   └── socket.js
│   │   └── styles/
│   │       └── global.css
│   └── index.html
└── README.md
```

---

## 🔌 API Endpoints

### Crear Sesión
```
POST /api/sessions
Body: {
  "professorId": "prof123",
  "professorName": "Juan Pérez",
  "examName": "Matemáticas Básico",
  "duration": 120
}
Response: {
  "sessionId": "sess_abc123",
  "qrCode": "data:image/png;base64,...",
  "qrData": "https://app.com/student/sess_abc123",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### Obtener Sesión
```
GET /api/sessions/:sessionId
Response: {
  "sessionId": "sess_abc123",
  "professorName": "Juan Pérez",
  "examName": "Matemáticas Básico",
  "students": [
    {
      "studentId": "student_1",
      "name": "Carlos López",
      "joinedAt": "2024-01-15T10:35:00Z",
      "status": "active"
    }
  ],
  "alerts": [
    {
      "studentName": "Carlos López",
      "type": "window_blur",
      "timestamp": "2024-01-15T10:36:30Z",
      "message": "Perdió foco de ventana"
    }
  ]
}
```

### Finalizar Sesión
```
DELETE /api/sessions/:sessionId
Response: { "success": true }
```

### Expulsar Estudiante
```
POST /api/sessions/:sessionId/expel/:studentId
Response: { "success": true }
```

---

## 🔄 Eventos WebSocket (Socket.io)

### Servidor → Cliente

**Para Profesor:**
- `student:joined` - Nuevo estudiante se conectó
  ```json
  { "studentId": "s1", "name": "Carlos", "timestamp": "..." }
  ```
- `student:left` - Estudiante se desconectó
  ```json
  { "studentId": "s1", "name": "Carlos" }
  ```
- `alert:triggered` - Alerta de actividad sospechosa
  ```json
  {
    "studentId": "s1",
    "studentName": "Carlos",
    "type": "window_blur | devtools | tab_switch | app_change",
    "timestamp": "2024-01-15T10:36:30Z",
    "message": "Perdió foco de ventana"
  }
  ```
- `session:ended` - Sesión finalizada por profesor
  ```json
  { "reason": "manual_close" }
  ```

**Para Estudiante:**
- `session:connected` - Conexión exitosa
  ```json
  {
    "sessionId": "sess_abc123",
    "students": [{ "name": "Carlos" }, { "name": "María" }]
  }
  ```
- `students:updated` - Actualización de lista de estudiantes
  ```json
  { "students": [...] }
  ```
- `student:expelled` - Profesor lo expulsó
  ```json
  { "reason": "expelled_by_professor" }
  ```
- `alert:recorded` - Alerta registrada
  ```json
  { "type": "window_blur", "message": "Actividad registrada" }
  ```

### Cliente → Servidor

**Estudiante emite:**
- `student:join` - Confirma entrada a la sesión
  ```json
  { "sessionId": "sess_abc123", "name": "Carlos López" }
  ```
- `student:event` - Registra evento de alerta
  ```json
  {
    "sessionId": "sess_abc123",
    "type": "window_blur | devtools | tab_switch | app_change",
    "timestamp": "..."
  }
  ```
- `student:leave` - Se va voluntariamente
  ```json
  { "sessionId": "sess_abc123" }
  ```

**Profesor emite:**
- `professor:join` - Se conecta al panel
  ```json
  { "sessionId": "sess_abc123", "professorId": "prof123" }
  ```
- `professor:expel` - Expulsa estudiante
  ```json
  { "sessionId": "sess_abc123", "studentId": "student_1" }
  ```

---

## 🎮 Flujo de Usuario

### Flujo Profesor
1. Accede a `/professor`
2. Completa formulario: Nombre, Materia, Duración
3. Sistema genera sesión y muestra QR
4. QR se visualiza en pantalla/proyector
5. Ve lista de estudiantes en tiempo real
6. Recibe alertas de actividad sospechosa
7. Puede expulsar estudiantes individuales
8. Finaliza sesión manualmente

### Flujo Estudiante
1. Accede a `/student`
2. Abre QR Scanner
3. Escanea código desde la pantalla del profesor
4. Es redirigido a `/student/:sessionId`
5. Ingresa su nombre
6. Pantalla se bloquea (fullscreen mode)
7. Ve lista de compañeros conectados
8. Durante la sesión:
   - Monitor de actividad y alertas
   - Contador de tiempo
   - Sistema detecta intentos de salida
9. Cuando termina: profesor finaliza sesión
10. Se muestra pantalla de fin de sesión

---

## 🔒 Mecanismos Anti-Fraude

### Bloqueos y Detecciones Implementar:
1. **Window Blur Detection** - Cuando pierde foco (click en otra app/pestaña)
2. **Tab Visibility API** - Detecta si cambió de tab
3. **DevTools Detection** - Detecta si abre herramientas de desarrollador
4. **Fullscreen Lock** - Bloquea modo pantalla completa
5. **Context Menu Block** - Desactiva click derecho
6. **Keyboard Shortcuts Block** - Bloquea F12, Ctrl+Shift+I, Ctrl+K, etc.
7. **Mobile App Switch Detection** - Detecta si cambia de app en móvil
8. **Navigation Prevention** - Bloquea botones atrás/adelante

### Alertas Generadas:
- Pérdida de foco de ventana
- Intento de cambiar de tab
- Intento de abrir DevTools
- Intento de navegar (atrás/adelante)
- Cambio de app en móvil
- Cierre de ventana
- Timeout de inactividad

---

## 🚀 Instalación y Deploy

### Backend (Node.js)
```bash
cd backend
npm install
npm start
# Server en puerto 3001
```

### Frontend (React)
```bash
cd frontend
npm install
npm run dev
# Dev server en puerto 5173
```

### Variables de Entorno Backend
```
PORT=3001
FRONTEND_URL=http://localhost:5173
NODE_ENV=development
```

---

## 📊 Casos de Uso

### Caso 1: Examen Normal
1. Profesor crea sesión (60 min, Matemáticas)
2. 25 estudiantes escanean QR
3. Todos ingresan nombre
4. Durante 60 min: sistema monitorea
5. Profesor ve lista en tiempo real
6. Si alguien intenta copiarse: ALERTA
7. Termina tiempo: sesión se cierra

### Caso 2: Estudiante Intenta Fraude
1. Carlos escanea QR
2. Durante examen: intenta abrir Google
3. El sistema detecta "window_blur"
4. Se registra alerta en panel profesor
5. Profesor ve: "Carlos perdió foco a las 10:36"
6. Profesor puede expulsarlo

### Caso 3: Móvil
1. María escanea con móvil
2. App se abre en pantalla completa
3. Si intenta abrir WhatsApp: detecta "app_change"
4. Alerta inmediata

---

## ⚙️ Dependencias Backend
```json
{
  "express": "^4.18.2",
  "socket.io": "^4.5.4",
  "cors": "^2.8.5",
  "uuid": "^9.0.0",
  "qrcode": "^1.5.3",
  "dotenv": "^16.0.3"
}
```

## ⚙️ Dependencias Frontend
```json
{
  "react": "^18.2.0",
  "react-dom": "^18.2.0",
  "socket.io-client": "^4.5.4",
  "html5-qrcode": "^2.3.4",
  "qrcode.react": "^1.0.1",
  "axios": "^1.4.0",
  "react-router-dom": "^6.11.2"
}
```

---

## 🔐 Seguridad

- [ ] Validar QR en backend antes de asignar a sesión
- [ ] Limitar conexiones por IP si es posible
- [ ] Timeout de sesión (1 hora por defecto)
- [ ] Encriptar comunicación Socket.io con autenticación
- [ ] Logs de todas las actividades
- [ ] No guardar datos sensibles localmente en cliente
- [ ] Rate limiting en endpoints

---

## ✅ Checklist MVP

- [ ] Backend: CRUD sesiones
- [ ] Backend: WebSocket eventos
- [ ] Frontend: QR Scanner
- [ ] Frontend: Panel Profesor
- [ ] Frontend: Pantalla Estudiante Bloqueada
- [ ] Detección: Window Blur
- [ ] Detección: Tab Visibility
- [ ] Detección: DevTools
- [ ] Detección: Navegación
- [ ] Sistema de Alertas
- [ ] Lista de Estudiantes en Vivo
- [ ] Expulsión de Estudiantes
- [ ] Finalizar Sesión

---

## 📝 Notas Adicionales

- El QR es específico por sesión y expira cuando la sesión termina
- Los datos se mantienen solo en memoria (sesión viva)
- Ideal para exámenes de corta a media duración
- Testeado en Chrome, Firefox, Safari y navegadores móviles
- Compatible con tablets y smartphones
- Interface responsive y touch-friendly