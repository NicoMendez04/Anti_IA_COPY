import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

// La configuración web de Firebase es pública: identifica el proyecto, no da acceso a datos.
const app = initializeApp({
  apiKey: 'AIzaSyDK36Ld-QSesJx8tWdcC2YQS_EVxdu_1og',
  authDomain: 'logostecanico.firebaseapp.com',
  projectId: 'logostecanico',
  storageBucket: 'logostecanico.firebasestorage.app',
  messagingSenderId: '981534150783',
  appId: '1:981534150783:web:6518cb6d507ae28de36f4a'
});

export const firebaseAuth = getAuth(app);
