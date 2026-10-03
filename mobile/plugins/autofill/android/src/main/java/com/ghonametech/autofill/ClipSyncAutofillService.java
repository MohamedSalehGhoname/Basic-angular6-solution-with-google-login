package com.ghonametech.autofill;

import android.app.PendingIntent;
import android.app.assist.AssistStructure;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.service.autofill.AutofillService;
import android.service.autofill.Dataset;
import android.service.autofill.Field;
import android.service.autofill.FillCallback;
import android.service.autofill.FillRequest;
import android.service.autofill.FillResponse;
import android.service.autofill.InlinePresentation;
import android.service.autofill.Presentations;
import android.service.autofill.SaveCallback;
import android.service.autofill.SaveInfo;
import android.service.autofill.SaveRequest;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillValue;
import android.view.inputmethod.InlineSuggestionsRequest;
import android.widget.RemoteViews;
import android.widget.inline.InlinePresentationSpec;
import androidx.annotation.NonNull;
import androidx.annotation.RequiresApi;
import androidx.autofill.inline.UiVersions;
import androidx.autofill.inline.v1.InlineSuggestionUi;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Offers the user's saved passwords to any app or web page that asks Android
 * for autofill.
 *
 * The service never sees a password. Everything in the vault is encrypted
 * with a key this process does not hold, so instead of returning values it
 * returns a dataset that needs *authentication*: tapping the suggestion opens
 * {@link AutofillActivity}, which runs the app, unlocks the vault behind a
 * fingerprint and hands the chosen values back. That keeps decryption in one
 * place and keeps a second copy of the secrets off the device.
 */
@RequiresApi(api = Build.VERSION_CODES.O)
public class ClipSyncAutofillService extends AutofillService {

    private static final int FILL_REQUEST_CODE = 1001;
    private static final int SAVE_REQUEST_CODE = 1002;

    /** Keeps the offer listed whatever the user has typed so far. */
    private static final Pattern MATCH_ANYTHING = Pattern.compile(".*", Pattern.DOTALL);

    @Override
    public void onFillRequest(
        @NonNull FillRequest request,
        @NonNull CancellationSignal cancellationSignal,
        @NonNull FillCallback callback
    ) {
        List<android.service.autofill.FillContext> contexts = request.getFillContexts();
        if (contexts.isEmpty()) {
            callback.onSuccess(null);
            return;
        }
        AssistStructure structure = contexts.get(contexts.size() - 1).getStructure();
        FillRequestFields fields = FillRequestFields.from(structure);
        if (!fields.hasFields() || isOurOwnScreen(fields)) {
            // Nothing here looks like a sign-in; stay out of the way.
            callback.onSuccess(null);
            return;
        }

        PendingFill.setFill(fields);

        Intent intent = new Intent(this, AutofillActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
            this,
            FILL_REQUEST_CODE,
            intent,
            PendingIntent.FLAG_CANCEL_CURRENT | PendingIntent.FLAG_MUTABLE
        );

        RemoteViews presentation = suggestion(getString(R.string.autofill_unlock_to_fill));
        InlinePresentation inline = inlineSuggestion(request, pending);

        Dataset.Builder dataset = newDataset(presentation);
        dataset.setAuthentication(pending.getIntentSender());
        // Every field the dataset claims must be listed, even with no value:
        // the real values arrive after authentication.
        for (AutofillId id : fields.usernameIds) {
            addField(dataset, id, presentation, inline);
        }
        for (AutofillId id : fields.passwordIds) {
            addField(dataset, id, presentation, inline);
        }

        FillResponse.Builder response = new FillResponse.Builder();
        response.addDataset(dataset.build());

        // Android asks to save once every *required* field has been filled in.
        // A password is the strongest signal the form was really used, so it
        // is required when the screen has one; on a passwordless sign-in the
        // address takes that role, and the rest are optional so a half-filled
        // form still offers what it has.
        boolean hasPassword = !fields.passwordIds.isEmpty();
        AutofillId[] required = ids(hasPassword ? fields.passwordIds : fields.usernameIds);
        AutofillId[] optional = ids(hasPassword ? fields.usernameIds : fields.passwordIds);
        if (required.length > 0) {
            SaveInfo.Builder save = new SaveInfo.Builder(
                SaveInfo.SAVE_DATA_TYPE_USERNAME | SaveInfo.SAVE_DATA_TYPE_PASSWORD,
                required
            );
            if (optional.length > 0) {
                save.setOptionalIds(optional);
            }
            response.setSaveInfo(save.build());
        }
        callback.onSuccess(response.build());
    }

    @Override
    public void onSaveRequest(@NonNull SaveRequest request, @NonNull SaveCallback callback) {
        List<android.service.autofill.FillContext> contexts = request.getFillContexts();
        if (contexts.isEmpty()) {
            callback.onSuccess();
            return;
        }
        AssistStructure structure = contexts.get(contexts.size() - 1).getStructure();
        FillRequestFields fields = FillRequestFields.from(structure);
        if (isOurOwnScreen(fields)) {
            callback.onSuccess();
            return;
        }
        String username = firstValue(structure, fields.usernameIds);
        String password = firstValue(structure, fields.passwordIds);
        // Plenty of sign-ins have no password at all — an address and a code
        // sent to it. Remembering just the address still saves the user from
        // guessing which of their addresses they used here.
        boolean anything = (password != null && !password.isEmpty())
            || (username != null && !username.isEmpty());
        if (!anything) {
            callback.onSuccess();
            return;
        }

        PendingFill.setSave(fields, username, password);
        Intent intent = new Intent(this, AutofillActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
            this,
            SAVE_REQUEST_CODE,
            intent,
            PendingIntent.FLAG_CANCEL_CURRENT | PendingIntent.FLAG_MUTABLE
        );
        // Saving means encrypting, which only the app can do, so hand the user
        // over to it rather than reporting a success we have not earned.
        callback.onSuccess(pending.getIntentSender());
    }

    /**
     * Our own unlock screen has a password field, and it runs in a WebView
     * whose origin is localhost, so without this Android offers to save the
     * vault passphrase into the vault — under the name "Localhost". A password
     * manager has no business filling or storing its own master passphrase.
     */
    private boolean isOurOwnScreen(FillRequestFields fields) {
        return getPackageName().equals(fields.packageName);
    }

    /**
     * A suggestion drawn inside the keyboard's own suggestion strip, when the
     * keyboard offers to host one (Android 11 and later).
     *
     * This is not only nicer to look at. The floating window Android puts up
     * otherwise takes the input focus, so the first key the user pressed
     * dismissed it, focus went back to the app with no editor attached yet,
     * and the system hid the keyboard — the user typed one letter and the
     * keyboard shut. Inside the strip there is no extra window and nothing to
     * lose focus to.
     */
    private InlinePresentation inlineSuggestion(FillRequest request, PendingIntent pending) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return null;
        }
        InlineSuggestionsRequest inlineRequest = request.getInlineSuggestionsRequest();
        if (inlineRequest == null || inlineRequest.getMaxSuggestionCount() <= 0) {
            return null;
        }
        List<InlinePresentationSpec> specs = inlineRequest.getInlinePresentationSpecs();
        if (specs == null || specs.isEmpty()) {
            return null;
        }
        InlinePresentationSpec spec = specs.get(0);
        Bundle style = spec.getStyle();
        if (style == null || !UiVersions.getVersions(style).contains(UiVersions.INLINE_UI_VERSION_1)) {
            // A keyboard whose strip we do not know how to draw in.
            return null;
        }
        try {
            return new InlinePresentation(
                InlineSuggestionUi
                    .newContentBuilder(pending)
                    .setTitle(getString(R.string.autofill_inline_title))
                    .setSubtitle(getString(R.string.autofill_inline_subtitle))
                    .build()
                    .getSlice(),
                spec,
                /* pinned= */ false
            );
        } catch (RuntimeException e) {
            // Never let a presentation problem cost the user their suggestion.
            return null;
        }
    }

    private Dataset.Builder newDataset(RemoteViews presentation) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Each field carries its own presentation on this version.
            return new Dataset.Builder();
        }
        return new Dataset.Builder(presentation);
    }

    /**
     * Adds one field to the dataset, keeping the suggestion on screen while
     * the user types: without a filter Android hides a dataset that has no
     * value to match against, so the offer vanished on the first keystroke and
     * only came back by leaving the field and returning to it.
     */
    private void addField(
        Dataset.Builder dataset,
        AutofillId id,
        RemoteViews presentation,
        InlinePresentation inline
    ) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Presentations.Builder presentations = new Presentations.Builder()
                .setMenuPresentation(presentation);
            if (inline != null) {
                presentations.setInlinePresentation(inline);
            }
            dataset.setField(
                id,
                new Field.Builder()
                    .setPresentations(presentations.build())
                    .setFilter(MATCH_ANYTHING)
                    .build()
            );
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && inline != null) {
            dataset.setValue(id, null, presentation, inline);
            return;
        }
        dataset.setValue(id, null, MATCH_ANYTHING, presentation);
    }

    private AutofillId[] ids(List<AutofillId> from) {
        return from.toArray(new AutofillId[0]);
    }

    /** Reads what the user typed into the first of the given fields. */
    private String firstValue(AssistStructure structure, List<AutofillId> ids) {
        for (AutofillId id : ids) {
            String value = findValue(structure, id);
            if (value != null && !value.isEmpty()) {
                return value;
            }
        }
        return null;
    }

    private String findValue(AssistStructure structure, AutofillId id) {
        for (int i = 0; i < structure.getWindowNodeCount(); i += 1) {
            String value = findValue(structure.getWindowNodeAt(i).getRootViewNode(), id);
            if (value != null) {
                return value;
            }
        }
        return null;
    }

    private String findValue(AssistStructure.ViewNode node, AutofillId id) {
        if (node == null) {
            return null;
        }
        if (id.equals(node.getAutofillId())) {
            AutofillValue value = node.getAutofillValue();
            if (value != null && value.isText()) {
                return value.getTextValue().toString();
            }
            return null;
        }
        for (int i = 0; i < node.getChildCount(); i += 1) {
            String value = findValue(node.getChildAt(i), id);
            if (value != null) {
                return value;
            }
        }
        return null;
    }

    private RemoteViews suggestion(String label) {
        RemoteViews views = new RemoteViews(getPackageName(), R.layout.autofill_suggestion);
        views.setTextViewText(R.id.autofill_suggestion_text, label);
        return views;
    }
}
