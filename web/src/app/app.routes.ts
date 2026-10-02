import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { unlockGuard } from './core/vault.guard';
import { Autofill } from './pages/autofill/autofill';
import { Clipboard } from './pages/clipboard/clipboard';
import { Codes } from './pages/codes/codes';
import { Login } from './pages/login/login';
import { Secrets } from './pages/secrets/secrets';
import { Settings } from './pages/settings/settings';
import { Share } from './pages/share/share';
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
  {
    path: 'codes',
    component: Codes,
    canActivate: [authGuard, unlockGuard],
    title: 'Two-factor codes · Clipboard Sync',
  },
  {
    path: 'secrets',
    component: Secrets,
    canActivate: [authGuard, unlockGuard],
    title: 'Secrets · Clipboard Sync',
  },
  {
    // Opened by Android when the user picks our autofill suggestion. It needs
    // an unlocked vault like any other page, but reaches /unlock itself so it
    // can come back here afterwards.
    path: 'autofill',
    component: Autofill,
    canActivate: [authGuard],
    title: 'Autofill · Clipboard Sync',
  },
  {
    path: 'settings',
    component: Settings,
    canActivate: [authGuard, unlockGuard],
    title: 'Settings · Clipboard Sync',
  },
  {
    // A link somebody was sent. No sign-in, no vault, no guards: the page is
    // for a recipient who has no account here, and the key to read the file
    // arrives in the URL fragment, which never reaches the server.
    path: 's/:token',
    component: Share,
    title: 'Shared file · Clipboard Sync',
  },
  { path: '**', redirectTo: '' },
];
