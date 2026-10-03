package com.ghonametech.qrscanner;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.moduleinstall.ModuleInstall;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

/**
 * Reads one QR code and hands back its text.
 *
 * The camera is opened by Google Play services, not by this app: the scanning
 * UI belongs to that process, so there is no camera permission to ask for and
 * no frame of video ever reaches us — only the decoded string. For a feature
 * whose whole job is to take in a secret, that is the smallest surface we can
 * ask the user to trust.
 */
@CapacitorPlugin(name = "QrScanner")
public class QrScannerPlugin extends Plugin {

    /** Whether this device can scan at all (it needs Play services). */
    @PluginMethod
    public void available(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", true);
        call.resolve(result);
    }

    /**
     * Opens the scanner and resolves with `{ value }`. Rejects with the code
     * `cancelled` when the user backs out, which callers treat as "nothing
     * happened" rather than an error worth showing.
     */
    @PluginMethod
    public void scan(PluginCall call) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(getContext(), options);
        scanner
            .startScan()
            .addOnSuccessListener(barcode -> {
                JSObject result = new JSObject();
                String value = barcode.getRawValue();
                if (value == null) {
                    value = barcode.getDisplayValue();
                }
                result.put("value", value == null ? "" : value);
                call.resolve(result);
            })
            .addOnCanceledListener(() -> call.reject("Scanning was cancelled", "cancelled"))
            .addOnFailureListener(error -> call.reject(message(error), "failed"));
    }

    private String message(Exception error) {
        String text = error.getMessage();
        return text == null || text.isEmpty() ? "The scanner could not start" : text;
    }
}
