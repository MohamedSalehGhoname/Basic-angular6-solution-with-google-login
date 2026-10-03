import { Component, inject } from '@angular/core';
import { I18nService } from '../core/i18n/i18n.service';

/**
 * Sits under every page, signed in or not. Small enough to stay out of the
 * way, present enough to say where the app comes from.
 */
@Component({
  selector: 'app-footer',
  template: `
    <footer>
      <span>{{ i18n.t('footer.product') }}</span>
      <a href="https://ghomicrosystems.com" target="_blank" rel="noopener noreferrer">
        GhoMicrosystems.com
      </a>
    </footer>
  `,
  styles: `
    footer {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      justify-content: center;
      align-items: baseline;
      padding: 2rem 1rem 1.5rem;
      font-size: 0.8125rem;
      color: var(--text-subtle);
    }

    a {
      color: inherit;
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    a:hover {
      color: var(--text);
    }
  `,
})
export class Footer {
  protected readonly i18n = inject(I18nService);
}
