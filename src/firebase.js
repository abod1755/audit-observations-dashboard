import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCuzbQfDFZpfUHVM6CLBr9s1Rl8VjfXbbg",
  authDomain: "iam-dashboard-175.firebaseapp.com",
  projectId: "iam-dashboard-175",
  storageBucket: "iam-dashboard-175.firebasestorage.app",
  messagingSenderId: "532916055741",
  appId: "1:532916055741:web:9521c996f5cf3983e611d4",
  measurementId: "G-HLTREFGP4P"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
