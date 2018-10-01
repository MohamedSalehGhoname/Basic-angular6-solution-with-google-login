import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NewCaseComponent } from './new-case/new-case.component';
import { CaseDetailsComponent } from './case-details/case-details.component';
import { CaseListComponent } from './case-list/case-list.component';
import { RouterModule } from '@angular/router';

@NgModule({
  imports: [
    CommonModule,
    RouterModule
  ],
  declarations: [NewCaseComponent, CaseDetailsComponent, CaseListComponent]
})
export class CaseModule { }
