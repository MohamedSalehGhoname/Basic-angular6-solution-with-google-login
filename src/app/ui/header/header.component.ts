import { AuthService } from './../../services/auth.service';
import { Component, OnInit } from '@angular/core';
import { UiService } from '../ui.service';

@Component({
  selector: 'app-header',
  templateUrl: './header.component.html',
  styleUrls: ['./header.component.css']
})
export class HeaderComponent {

  isNavbarCollapsed=true;

  constructor(public uiService: UiService,public authService:AuthService) { }


}
