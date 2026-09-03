/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
