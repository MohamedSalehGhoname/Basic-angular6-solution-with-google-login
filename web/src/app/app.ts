import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DesktopCaptureService } from './core/desktop-capture.service';
import { I18nService } from './core/i18n/i18n.service';
import { Header } from './layout/header';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Header],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  // Constructed at startup so desktop clipboard capture is wired app-wide.
  private readonly desktopCapture = inject(DesktopCaptureService);
  // Instantiated at startup so it applies the saved language/direction.
  private readonly i18n = inject(I18nService);
}
