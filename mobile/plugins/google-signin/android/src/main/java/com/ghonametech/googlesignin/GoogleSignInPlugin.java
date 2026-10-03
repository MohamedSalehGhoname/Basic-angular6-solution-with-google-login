package com.ghonametech.googlesignin;

import androidx.credentials.ClearCredentialStateRequest;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.ClearCredentialException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import java.util.concurrent.Executors;

/**
 * Google sign-in on the phone, through Android's Credential Manager: the
 * account picker is the system's own, so it works where Google refuses to
 * show its sign-in page inside an app's WebView.
 *
 * It hands the web app a Google ID token, which the app exchanges for a
 * Firebase session with signInWithCredential — the same account the website
 * and desktop app sign into.
 */
@CapacitorPlugin(name = "GoogleSignIn")
public class GoogleSignInPlugin extends Plugin {

    @PluginMethod
    public void signIn(PluginCall call) {
        String serverClientId = call.getString("serverClientId");
        if (serverClientId == null || serverClientId.isEmpty()) {
            call.reject("Missing serverClientId", "invalid");
            return;
        }
        // The explicit "Sign in with Google" flow: the button the user just
        // pressed. (GetGoogleIdOption, the one-tap variant, opens the picker
        // and never returns a result on this phone's selector.)
        GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(serverClientId).build();
        GetCredentialRequest request = new GetCredentialRequest.Builder().addCredentialOption(option).build();

        CredentialManager.create(getContext())
            .getCredentialAsync(
                getActivity(),
                request,
                null,
                Executors.newSingleThreadExecutor(),
                new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                    @Override
                    public void onResult(GetCredentialResponse response) {
                        Credential credential = response.getCredential();
                        if (
                            credential instanceof CustomCredential &&
                            GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())
                        ) {
                            GoogleIdTokenCredential google = GoogleIdTokenCredential.createFrom(
                                ((CustomCredential) credential).getData()
                            );
                            JSObject result = new JSObject();
                            result.put("idToken", google.getIdToken());
                            result.put("email", google.getId());
                            call.resolve(result);
                        } else {
                            call.reject("Unexpected credential type", "failed");
                        }
                    }

                    @Override
                    public void onError(GetCredentialException e) {
                        boolean cancelled = e instanceof GetCredentialCancellationException;
                        call.reject(e.getMessage(), cancelled ? "cancelled" : "failed");
                    }
                }
            );
    }

    /** Forgets the chosen account so the next sign-in asks again. */
    @PluginMethod
    public void signOut(PluginCall call) {
        CredentialManager.create(getContext())
            .clearCredentialStateAsync(
                new ClearCredentialStateRequest(),
                null,
                Executors.newSingleThreadExecutor(),
                new CredentialManagerCallback<Void, ClearCredentialException>() {
                    @Override
                    public void onResult(Void unused) {
                        call.resolve();
                    }

                    @Override
                    public void onError(ClearCredentialException e) {
                        // Nothing to clear is not a failure worth surfacing.
                        call.resolve();
                    }
                }
            );
    }
}
