import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCwRPc6JCurJMa2-verO3XLJxYqpd3l-Mg",
  authDomain: "iam-dashboard-1755.firebaseapp.com",
  projectId: "iam-dashboard-1755",
  storageBucket: "iam-dashboard-1755.firebasestorage.app",
  messagingSenderId: "960424171655",
  appId: "1:960424171655:web:d60dbaecdf440b90ed4022",
  measurementId: "G-R4982HLCL9"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
