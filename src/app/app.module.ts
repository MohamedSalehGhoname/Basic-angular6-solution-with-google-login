import { BrowserModule } from '@angular/platform-browser';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { NgModule } from '@angular/core';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import {NgbModule} from '@ng-bootstrap/ng-bootstrap';
import { UiModule } from './ui/ui.module';
import { CoreModule } from './core/core.module';
import { AngularFireModule } from '@angular/fire';
import { environment } from '../environments/environment';
import { AngularFirestoreModule } from '@angular/fire/firestore';
import { AngularFireStorageModule } from '@angular/fire/storage';
import { UserProfileComponent } from './user-profile/user-profile.component';
import { HomeComponent } from './home/home.component';
import { RouterModule } from '@angular/router';
import { CaseModule } from './case/case.module';
import { ProfileComponent } from './users/profile/profile.component';
import { UsersListComponent } from './users/users-list/users-list.component';
import { SignupComponent } from './users/signup/signup.component';
import { LoginComponent } from './users/login/login.component';
import { LoggedinGuard } from './core/loggedin.guard';

@NgModule({
  declarations: [
    AppComponent,
    UserProfileComponent,
    HomeComponent,
    ProfileComponent,
    UsersListComponent,
    SignupComponent,
    LoginComponent  
  ],
  imports: [
    BrowserModule,
    NgbModule,
    AppRoutingModule,
    FormsModule,
    ReactiveFormsModule,
    UiModule,
    CoreModule,
    
    AngularFireModule.initializeApp(environment.firebase),
    AngularFirestoreModule,   
    AngularFireStorageModule,
    RouterModule,
    CaseModule
  ],
  providers: [LoggedinGuard],
  bootstrap: [AppComponent]
})
export class AppModule { }
