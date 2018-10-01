import { AuthService } from './../services/auth.service';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LayoutComponent } from './layout/layout.component';
import { HeaderComponent } from './header/header.component';
import { FooterComponent } from './footer/footer.component';
import { UiService } from './ui.service';
import { RouterModule } from '@angular/router';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { AvatarComponent } from './avatar/avatar.component';

@NgModule({
  imports: [
    CommonModule,
    RouterModule,
    NgbModule.forRoot(),
  ],
  declarations: [LayoutComponent, HeaderComponent, FooterComponent, AvatarComponent],
  exports: [LayoutComponent],
  providers:[UiService,AuthService]

})
export class UiModule { }
