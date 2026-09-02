using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;

namespace WpfTaskFixture;

public partial class MainWindow : Window
{
    public ObservableCollection<string> Rows { get; } = new(
        Enumerable.Range(1, 40).Select(index => $"WPF scroll row {index:00}"));

    public MainWindow()
    {
        InitializeComponent();
        DataContext = this;
        Input.PreviewKeyDown += (_, args) =>
        {
            if (args.Key == System.Windows.Input.Key.Enter)
            {
                Status.Text = "enter-received-by-fixture";
                args.Handled = true;
            }
        };
        Loaded += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            Console.WriteLine($"READY {Environment.ProcessId} {hwnd.ToInt64()}");
            Console.Out.Flush();
        };
    }

    void ActionButton_Click(object sender, RoutedEventArgs e) => Status.Text = "clicked";
    void ActionButton_StateChanged(object sender, RoutedEventArgs e) => Status.Text = "clicked";
    void ChoiceList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (Status is not null && ChoiceList.SelectedItem is ListBoxItem item)
            Status.Text = $"selected:{item.Content}";
    }
    void Toggle_Click(object sender, RoutedEventArgs e) =>
        Status.Text = Toggle.IsChecked == true ? "toggled:on" : "toggled:off";
    void Toggle_StateChanged(object sender, RoutedEventArgs e) =>
        Status.Text = Toggle.IsChecked == true ? "toggled:on" : "toggled:off";
}
