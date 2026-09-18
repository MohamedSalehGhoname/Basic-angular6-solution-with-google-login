import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { unlockGuard } from './core/vault.guard';
import { Clipboard } from './pages/clipboard/clipboard';
import { Login } from './pages/login/login';
import { Unlock } from './pages/unlock/unlock';

export const routes: Routes = [
  { path: 'login', component: Login, title: 'Sign in · Clipboard Sync' },
  { path: 'unlock', component: Unlock, canActivate: [authGuard], title: 'Unlock · Clipboard Sync' },
  {
    path: '',
    component: Clipboard,
    canActivate: [authGuard, unlockGuard],
    title: 'Clipboard Sync',
  },
  { path: '**', redirectTo: '' },
];
