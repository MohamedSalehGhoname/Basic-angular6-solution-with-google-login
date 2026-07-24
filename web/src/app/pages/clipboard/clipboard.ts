import { DatePipe } from '@angular/common';
import { Component, signal } from '@angular/core';

export interface ClipboardItem {
  id: string;
  preview: string;
  device: string;
  copiedAt: Date;
}

@Component({
  selector: 'app-clipboard',
  imports: [DatePipe],
  templateUrl: './clipboard.html',
  styleUrl: './clipboard.css',
})
export class Clipboard {
  // Will be fed by the encrypted sync backend; empty until that exists.
  protected readonly items = signal<ClipboardItem[]>([]);
}
