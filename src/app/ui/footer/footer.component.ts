import { Component, OnInit } from '@angular/core';
import { UiService } from '../ui.service';

@Component({
  selector: 'app-footer',
  templateUrl: './footer.component.html',
  styleUrls: ['./footer.component.css']
})
export class FooterComponent implements OnInit {

  constructor(public uiService:UiService) { }

  navbarsettings = {
    "fixed-top": this.uiService.fixedTopNavBar,
    "navbar-dark":!this.uiService.lightNavBar ,
    "navbar-light":this.uiService.lightNavBar,
    "bg-dark": !this.uiService.lightNavBar ,
    "bg-light": this.uiService.lightNavBar 
  }

  ngOnInit() {
  }

}
