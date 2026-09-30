/* Link-time libsecret fixture: exercise the helper without a desktop keyring. */
#include <libsecret/secret.h>
#include <string.h>

static gchar *scenario;

GList *__wrap_secret_service_search_sync(SecretService *service,
                                        const SecretSchema *schema,
                                        GHashTable *attributes,
                                        SecretSearchFlags flags,
                                        GCancellable *cancellable,
                                        GError **error) {
    (void)service;
    (void)cancellable;
    g_assert_true((schema->flags & SECRET_SCHEMA_DONT_MATCH_NAME) != 0);
    g_assert_true((flags & SECRET_SEARCH_UNLOCK) != 0);
    g_assert_true((flags & SECRET_SEARCH_LOAD_SECRETS) != 0);
    g_free(scenario);
    scenario = g_strdup(g_hash_table_lookup(attributes, "application"));
    if (strcmp(scenario, "missing") == 0) return NULL;
    if (strcmp(scenario, "cancelled") == 0) {
        g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_CANCELLED, "cancelled");
        return NULL;
    }
    if (strcmp(scenario, "denied") == 0) {
        g_set_error_literal(error, G_DBUS_ERROR, G_DBUS_ERROR_ACCESS_DENIED, "denied");
        return NULL;
    }
    if (strcmp(scenario, "unavailable") == 0) {
        g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED, "unavailable");
        return NULL;
    }
    return g_list_append(NULL, g_object_new(SECRET_TYPE_ITEM, NULL));
}

gboolean __wrap_secret_item_get_locked(SecretItem *item) {
    (void)item;
    return strcmp(scenario, "locked") == 0;
}

SecretValue *__wrap_secret_item_get_secret(SecretItem *item) {
    (void)item;
    if (strcmp(scenario, "unloaded") == 0) return NULL;
    if (strcmp(scenario, "empty") == 0) return secret_value_new("", 0, "text/plain");
    static const gchar bytes[] = "secret\0with whitespace \t\r\n";
    return secret_value_new(bytes, sizeof(bytes) - 1, "text/plain");
}
