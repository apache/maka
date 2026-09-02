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

using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;

namespace DeepTreeFixture;

static class Program
{
    [STAThread]
    static void Main()
    {
        var app = new Application();
        var window = new Window
        {
            Title = "maka-cu-windows-deep-tree-fixture",
            Width = 720,
            Height = 720,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
        };

        var root = new StackPanel { Margin = new Thickness(12) };
        root.Children.Add(new TextBlock { Text = "maka deep-tree fixture", FontSize = 18 });

        var siblings = new StackPanel { Margin = new Thickness(0, 8, 0, 8) };
        for (var index = 1; index <= 5; index++)
        {
            siblings.Children.Add(NamedEdit($"Sibling edit {index:00}", $"sibling-edit-{index:00}"));
            siblings.Children.Add(NamedButton($"Sibling button {index:00}", $"sibling-button-{index:00}"));
        }
        root.Children.Add(siblings);

        FrameworkElement nest = NamedEdit("Deep nested input", "deep-nested-input");
        for (var depth = 16; depth >= 1; depth--)
        {
            var panel = new StackPanel();
            panel.Children.Add(new TextBlock { Text = $"nest-{depth:00}", FontSize = 10 });
            if (depth == 8)
                panel.Children.Add(NamedEdit("Mid nested input", "mid-nested-input"));
            panel.Children.Add(nest);
            nest = new Border
            {
                Padding = new Thickness(2),
                BorderThickness = new Thickness(1),
                BorderBrush = Brushes.Gray,
                Child = panel,
            };
        }
        root.Children.Add(nest);
        window.Content = root;

        window.Loaded += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(window).Handle;
            Console.WriteLine($"READY {Environment.ProcessId} {hwnd.ToInt64()}");
            Console.Out.Flush();
        };

        _ = Task.Run(() =>
        {
            while (Console.ReadLine() is { } line)
            {
                if (string.Equals(line.Trim(), "shutdown", StringComparison.OrdinalIgnoreCase))
                {
                    window.Dispatcher.Invoke(window.Close);
                    break;
                }
            }
        });

        app.Run(window);
    }

    static TextBox NamedEdit(string name, string automationId)
    {
        var box = new TextBox
        {
            Width = 280,
            HorizontalAlignment = HorizontalAlignment.Left,
            Margin = new Thickness(0, 4, 0, 0),
        };
        AutomationProperties.SetName(box, name);
        AutomationProperties.SetAutomationId(box, automationId);
        return box;
    }

    static Button NamedButton(string name, string automationId)
    {
        var button = new Button
        {
            Content = name,
            Width = 180,
            HorizontalAlignment = HorizontalAlignment.Left,
            Margin = new Thickness(0, 4, 0, 0),
        };
        AutomationProperties.SetName(button, name);
        AutomationProperties.SetAutomationId(button, automationId);
        return button;
    }
}
