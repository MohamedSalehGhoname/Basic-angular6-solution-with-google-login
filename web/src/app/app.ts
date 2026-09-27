import { Component, inject } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter, firstValueFrom, take } from 'rxjs';
import { AutofillService } from './core/autofill.service';
import { DesktopCaptureService } from './core/desktop-capture.service';
import { FileShareService } from './core/file-share.service';
import { I18nService } from './core/i18n/i18n.service';
import { Footer } from './layout/footer';
import { Header } from './layout/header';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Header, Footer],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  // Constructed at startup so desktop clipboard capture is wired app-wide.
  private readonly desktopCapture = inject(DesktopCaptureService);
  // Likewise so files sent from Explorer are picked up on any page.
  private readonly fileShare = inject(FileShareService);
  // Instantiated at startup so it applies the saved language/direction.
  private readonly i18n = inject(I18nService);
  private readonly autofill = inject(AutofillService);
  private readonly router = inject(Router);

  constructor() {
    // Android starts the app at the root even when it opened it to answer an
    // autofill request, so the request itself is what decides the first page.
    void this.autofill.ready.then(async (request) => {
      if (!request) {
        return;
      }
      // The router's own first navigation happens after this component is
      // constructed and would otherwise land on the clipboard and win the
      // race, so let it finish before replacing it.
      if (!this.router.navigated) {
        await firstValueFrom(
          this.router.events.pipe(
            filter((event) => event instanceof NavigationEnd),
            take(1),
          ),
        );
      }
      await this.router.navigateByUrl('/autofill');
    });
  }
}
