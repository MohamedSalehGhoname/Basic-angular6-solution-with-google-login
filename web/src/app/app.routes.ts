import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { Clipboard } from './pages/clipboard/clipboard';
import { Login } from './pages/login/login';

export const routes: Routes = [
  { path: 'login', component: Login, title: 'Sign in · Clipboard Sync' },
  { path: '', component: Clipboard, canActivate: [authGuard], title: 'Clipboard Sync' },
  { path: '**', redirectTo: '' },
];
