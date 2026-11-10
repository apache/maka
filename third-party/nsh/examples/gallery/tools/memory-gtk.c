/* The GTK control for memory.py; build with:
 * cc -O2 examples/gallery/tools/memory-gtk.c -o target/agents/memory/gtk \
 *   $(pkg-config --cflags --libs gtk4)
 */
#include <gtk/gtk.h>

static void activate(GtkApplication *app, gpointer data) {
    (void)data;
    GtkWidget *window = gtk_application_window_new(app);
    gtk_window_set_default_size(GTK_WINDOW(window), 480, 640);
    gtk_window_set_child(GTK_WINDOW(window), gtk_label_new("Hello world"));
    gtk_window_present(GTK_WINDOW(window));
}

int main(int argc, char **argv) {
    GtkApplication *app = gtk_application_new("dev.nsh.memory.bare", G_APPLICATION_NON_UNIQUE);
    g_signal_connect(app, "activate", G_CALLBACK(activate), NULL);
    int result = g_application_run(G_APPLICATION(app), argc, argv);
    g_object_unref(app);
    return result;
}
