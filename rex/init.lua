-- Migrated from Herdr (~/.config/herdr/config.toml) and Ghostty.

-- Herdr prefix ctrl+b: pressing it twice sends ctrl+b to the program.
rex.bind("ctrl+b>ctrl+b", "pane.send_key", { key = "ctrl+b" })

-- Pane focus
rex.bind("ctrl+b>h", "pane.focus", { direction = "left" })
rex.bind("ctrl+alt+left", "pane.focus", { direction = "left" })
rex.bind("ctrl+b>j", "pane.focus", { direction = "down" })
rex.bind("ctrl+alt+down", "pane.focus", { direction = "down" })
rex.bind("ctrl+b>k", "pane.focus", { direction = "up" })
rex.bind("ctrl+alt+up", "pane.focus", { direction = "up" })
rex.bind("ctrl+b>l", "pane.focus", { direction = "right" })
rex.bind("ctrl+alt+right", "pane.focus", { direction = "right" })

-- Splits, zoom, close
rex.bind("ctrl+b>v", "pane.split", { direction = "right" })
rex.bind("ctrl+alt+d", "pane.split", { direction = "right" })
rex.bind("ctrl+b>-", "pane.split", { direction = "down" })
rex.bind("ctrl+alt+shift+d", "pane.split", { direction = "down" })
rex.bind("ctrl+b>z", "pane.zoom")
rex.bind("ctrl+alt+z", "pane.zoom")
rex.bind("ctrl+b>x", "pane.close")
rex.bind("ctrl+alt+w", "pane.close")

-- Tabs
rex.bind("ctrl+b>c", "client.tab.new")
rex.bind("ctrl+alt+t", "client.tab.new")
rex.bind("ctrl+b>p", "client.tab.previous")
rex.bind("ctrl+alt+[", "client.tab.previous")
rex.bind("ctrl+b>n", "client.tab.next")
rex.bind("ctrl+alt+]", "client.tab.next")

-- Sessions (Herdr workspaces)
rex.bind("ctrl+b>shift+n", "session.new")
rex.bind("ctrl+alt+shift+n", "session.new")
rex.bind("ctrl+alt+shift+[", "session.previous")
rex.bind("ctrl+alt+shift+]", "session.next")
