import { SignupComponent } from './users/signup/signup.component';
import { LoginComponent } from './users/login/login.component';
import { LoggedinGuard } from './core/loggedin.guard';
import { AppComponent } from './app.component';
import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';
import { UserProfileComponent } from './user-profile/user-profile.component';
import { HomeComponent } from './home/home.component';

const routes: Routes = [
  { path: 'login', component: LoginComponent},
  { path: 'signup', component: SignupComponent},
  { path: 'user', component: UserProfileComponent,canActivate:[LoggedinGuard]},
  { path: 'user', component: UserProfileComponent},
  { path: '', component: HomeComponent},
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
