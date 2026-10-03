package com.ghonametech.autofill;

import android.os.Build;
import android.os.Bundle;
import androidx.annotation.RequiresApi;
import com.getcapacitor.BridgeActivity;

/**
 * The screen Android opens when the user taps our autofill suggestion, or
 * accepts its offer to save a password.
 *
 * It is the app itself: the vault unlocks here the same way it does anywhere
 * else, and the chosen values go back to Android through
 * {@link AutofillPlugin}. Nothing about decryption lives in the service.
 *
 * The web app asks the plugin for the pending request as it starts and shows
 * the autofill screen when there is one, so this activity does not have to
 * drive navigation from the native side.
 */
@RequiresApi(api = Build.VERSION_CODES.O)
public class AutofillActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AutofillPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onDestroy() {
        PendingFill.clear();
        super.onDestroy();
    }
}
