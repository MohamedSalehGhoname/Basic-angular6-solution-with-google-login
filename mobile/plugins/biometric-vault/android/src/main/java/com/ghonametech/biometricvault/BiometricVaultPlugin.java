package com.ghonametech.biometricvault;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Keeps a secret (the vault key) sealed by an Android Keystore key that can
 * only be used right after a strong biometric check. The key never leaves
 * the secure hardware; the fingerprint prompt is what lets it decrypt, so
 * this is a cryptographic gate, not just a UI one. Enrolling a new
 * fingerprint on the phone permanently invalidates the key.
 */
@CapacitorPlugin(name = "BiometricVault")
public class BiometricVaultPlugin extends Plugin {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "clipsync_vault_key";
    private static final String PREFS = "clipsync_biometric";
    private static final String PREF_SEALED = "sealed";
    private static final String PREF_IV = "iv";
    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG;

    @PluginMethod
    public void status(PluginCall call) {
        int can = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS);
        JSObject result = new JSObject();
        result.put("available", can == BiometricManager.BIOMETRIC_SUCCESS);
        result.put("reason", reason(can));
        result.put("enrolled", prefs().contains(PREF_SEALED));
        call.resolve(result);
    }

    /** Seals {secret} after a fingerprint check. */
    @PluginMethod
    public void enroll(PluginCall call) {
        String secret = call.getString("secret");
        if (secret == null || secret.isEmpty()) {
            call.reject("Missing secret", "invalid");
            return;
        }
        Cipher cipher;
        try {
            deleteKey();
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, createKey());
        } catch (Exception e) {
            call.reject("Could not prepare the secure key: " + e.getMessage(), "unavailable");
            return;
        }
        authenticate(call, cipher, call.getString("title", "Turn on fingerprint unlock"), (authed) -> {
            byte[] sealed = authed.doFinal(secret.getBytes(StandardCharsets.UTF_8));
            prefs()
                .edit()
                .putString(PREF_SEALED, Base64.encodeToString(sealed, Base64.NO_WRAP))
                .putString(PREF_IV, Base64.encodeToString(authed.getIV(), Base64.NO_WRAP))
                .apply();
            call.resolve();
        });
    }

    /** Returns the sealed secret after a fingerprint check. */
    @PluginMethod
    public void unlock(PluginCall call) {
        SharedPreferences prefs = prefs();
        String sealed = prefs.getString(PREF_SEALED, null);
        String iv = prefs.getString(PREF_IV, null);
        if (sealed == null || iv == null) {
            call.reject("Fingerprint unlock is not set up", "not_enrolled");
            return;
        }
        Cipher cipher;
        try {
            KeyStore store = KeyStore.getInstance(KEYSTORE);
            store.load(null);
            SecretKey key = (SecretKey) store.getKey(KEY_ALIAS, null);
            if (key == null) {
                clear();
                call.reject("Fingerprint unlock is not set up", "not_enrolled");
                return;
            }
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
        } catch (KeyPermanentlyInvalidatedException e) {
            // A fingerprint was added or removed: the old key can never be used again.
            clear();
            call.reject("Fingerprints changed on this phone", "invalidated");
            return;
        } catch (Exception e) {
            call.reject("Could not open the secure key: " + e.getMessage(), "unavailable");
            return;
        }
        authenticate(call, cipher, call.getString("title", "Unlock Clipboard Sync"), (authed) -> {
            byte[] secret = authed.doFinal(Base64.decode(sealed, Base64.NO_WRAP));
            JSObject result = new JSObject();
            result.put("secret", new String(secret, StandardCharsets.UTF_8));
            call.resolve(result);
        });
    }

    @PluginMethod
    public void disable(PluginCall call) {
        clear();
        call.resolve();
    }

    private interface Sealed {
        void run(Cipher cipher) throws Exception;
    }

    private void authenticate(PluginCall call, Cipher cipher, String title, Sealed onSuccess) {
        FragmentActivity activity = getActivity();
        activity.runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(getContext()),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                        try {
                            BiometricPrompt.CryptoObject crypto = result.getCryptoObject();
                            if (crypto == null || crypto.getCipher() == null) {
                                call.reject("No key after authentication", "unavailable");
                                return;
                            }
                            onSuccess.run(crypto.getCipher());
                        } catch (Exception e) {
                            call.reject("Could not use the secure key: " + e.getMessage(), "unavailable");
                        }
                    }

                    @Override
                    public void onAuthenticationError(int code, @NonNull CharSequence message) {
                        boolean cancelled = code == BiometricPrompt.ERROR_USER_CANCELED
                            || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                            || code == BiometricPrompt.ERROR_CANCELED;
                        call.reject(message.toString(), cancelled ? "cancelled" : "failed");
                    }
                    // onAuthenticationFailed (a non-matching finger) just lets the user retry.
                }
            );
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setNegativeButtonText(call.getString("cancel", "Use passphrase"))
                .setAllowedAuthenticators(AUTHENTICATORS)
                .build();
            prompt.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
        });
    }

    private SecretKey createKey() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            // Usable only through a biometric prompt, once per operation.
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true);
        generator.init(spec.build());
        return generator.generateKey();
    }

    private void deleteKey() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) {
            store.deleteEntry(KEY_ALIAS);
        }
    }

    private void clear() {
        prefs().edit().clear().apply();
        try {
            deleteKey();
        } catch (Exception ignored) {
            // Nothing to delete.
        }
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String reason(int can) {
        switch (can) {
            case BiometricManager.BIOMETRIC_SUCCESS:
                return "ok";
            case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                return "none_enrolled";
            case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
            case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                return "no_hardware";
            default:
                return "unavailable";
        }
    }
}
