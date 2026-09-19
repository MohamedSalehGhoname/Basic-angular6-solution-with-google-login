import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { accessKeyRejected, getAccessKey, setAccessKey } from '../../core/access-key';
import { AuthService } from '../../core/auth.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { syncConfig } from '../../sync.config';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login {
  protected readonly auth = inject(AuthService);
  protected readonly i18n = inject(I18nService);
  private readonly route = inject(ActivatedRoute);

  protected readonly needsAccessKey = syncConfig.accessKeyRequired === true;
  protected readonly accessKeyRejected = accessKeyRejected;
  protected accessKey = getAccessKey() ?? '';

  protected signIn(): void {
    if (this.needsAccessKey) {
      if (!this.accessKey.trim()) {
        return;
      }
      setAccessKey(this.accessKey);
    }
    const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl') ?? '/';
    this.auth.loginWithGoogle(returnUrl);
  }
}
