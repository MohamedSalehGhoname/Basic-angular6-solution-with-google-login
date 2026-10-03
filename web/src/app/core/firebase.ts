import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { firebaseConfig } from '../firebase.config';

export const firebaseApp = initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(firebaseApp);
