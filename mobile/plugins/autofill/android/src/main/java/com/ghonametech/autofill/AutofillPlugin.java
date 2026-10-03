package com.ghonametech.autofill;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.service.autofill.Dataset;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillManager;
import android.view.autofill.AutofillValue;
import android.widget.RemoteViews;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * What the web app uses to take part in Android autofill: read the request
 * Android is waiting on, answer it with values the vault decrypted, and turn
 * the whole feature on or off from Settings.
 */
@CapacitorPlugin(name = "Autofill")
public class AutofillPlugin extends Plugin {

    /** Whether this device can do autofill at all, and whether we are the chosen service. */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        boolean supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O;
        result.put("supported", supported);
        result.put("enabled", supported && isOurService());
        call.resolve(result);
    }

    /** Opens the system page where the user picks their autofill service. */
    @PluginMethod
    public void openSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.reject("Autofill needs Android 8 or later", "unsupported");
            return;
        }
        Intent intent = new Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE);
        intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        try {
            getActivity().startActivity(intent);
        } catch (Exception err) {
            // Some devices hide that screen; the general settings page still works.
            getActivity().startActivity(new Intent(Settings.ACTION_SETTINGS));
        }
        call.resolve();
    }

    /**
     * The request this activity was opened for, or `{ kind: null }` when the
     * app was started normally. A save request carries what the user typed so
     * the app can store it.
     */
    @PluginMethod
    public void pending(PluginCall call) {
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            result.put("kind", null);
            call.resolve(result);
            return;
        }
        PendingFill fill = PendingFill.take();
        if (fill == null) {
            result.put("kind", null);
            call.resolve(result);
            return;
        }
        result.put("kind", fill.kind == PendingFill.Kind.SAVE ? "save" : "fill");
        result.put("identity", fill.fields.identity());
        result.put("webDomain", fill.fields.webDomain);
        result.put("packageName", fill.fields.packageName);
        result.put("wantsUsername", !fill.fields.usernameIds.isEmpty());
        result.put("wantsPassword", !fill.fields.passwordIds.isEmpty());
        result.put("username", fill.username);
        result.put("password", fill.password);
        call.resolve(result);
    }

    /** Fills the fields Android asked about and closes this screen. */
    @PluginMethod
    public void respond(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.reject("Autofill needs Android 8 or later", "unsupported");
            return;
        }
        PendingFill fill = PendingFill.take();
        Activity activity = getActivity();
        if (fill == null || activity == null) {
            call.reject("No autofill request is waiting", "no_request");
            return;
        }
        String username = call.getString("username", "");
        String password = call.getString("password", "");
        String label = call.getString("label", username);

        RemoteViews presentation = new RemoteViews(
            getContext().getPackageName(),
            R.layout.autofill_suggestion
        );
        presentation.setTextViewText(R.id.autofill_suggestion_text, label);

        Dataset.Builder dataset = new Dataset.Builder(presentation);
        boolean any = false;
        for (AutofillId id : fill.fields.usernameIds) {
            dataset.setValue(id, AutofillValue.forText(username), presentation);
            any = true;
        }
        for (AutofillId id : fill.fields.passwordIds) {
            dataset.setValue(id, AutofillValue.forText(password), presentation);
            any = true;
        }
        if (!any) {
            call.reject("Nothing on that screen can be filled", "no_fields");
            return;
        }

        Intent reply = new Intent();
        reply.putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset.build());
        activity.setResult(Activity.RESULT_OK, reply);
        PendingFill.clear();
        call.resolve();
        activity.finish();
    }

    /** Closes this screen without filling anything. */
    @PluginMethod
    public void cancel(PluginCall call) {
        Activity activity = getActivity();
        PendingFill.clear();
        call.resolve();
        if (activity != null) {
            activity.setResult(Activity.RESULT_CANCELED);
            activity.finish();
        }
    }

    private boolean isOurService() {
        AutofillManager manager = getContext().getSystemService(AutofillManager.class);
        return manager != null && manager.hasEnabledAutofillServices();
    }
}
