import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBSpbxo8F9h1nYCEybr_kdB7GShCKYQTCE",
  authDomain: "prime-level.firebaseapp.com",
  projectId: "prime-level",
  storageBucket: "prime-level.firebasestorage.app",
  messagingSenderId: "692689094575",
  appId: "1:692689094575:web:9a63467caa211d00f3915a",
  measurementId: "G-6BRYXRVN0H"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);