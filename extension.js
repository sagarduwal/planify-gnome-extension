const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Main = imports.ui.main;
const Util = imports.misc.util;
const ExtensionUtils = imports.misc.extensionUtils;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const GLib = imports.gi.GLib;
const ByteArray = imports.byteArray;
const Clutter = imports.gi.Clutter;
const Pango = imports.gi.Pango;

const Me = ExtensionUtils.getCurrentExtension();

let button = null;
let refreshTimeout = null;
let taskItems = [];

function _showPlanner() {
  Util.spawnCommandLine("flatpak run io.github.alainm23.planify");
}

function _checkSqliteInstalled() {
  try {
    let [result, stdout, stderr, status] =
      GLib.spawn_command_line_sync("which sqlite3");
    return status === 0;
  } catch (e) {
    return false;
  }
}

function _getTodayTasks() {
  taskItems.forEach((item) => {
    item.destroy();
  });
  taskItems = [];

  if (!_checkSqliteInstalled()) {
    const errorItem = new PopupMenu.PopupMenuItem(
      "sqlite3 command not found. Please install it."
    );
    errorItem.setSensitive(false);
    button.menu.addMenuItem(errorItem);
    taskItems.push(errorItem);

    const installItem = new PopupMenu.PopupMenuItem("Install sqlite3");
    installItem.connect("activate", () => {
      Util.spawnCommandLine(
        "gnome-terminal -- bash -c 'sudo apt update && sudo apt install -y sqlite3; echo \"Press Enter to close\"; read'"
      );
    });
    button.menu.addMenuItem(installItem);
    taskItems.push(installItem);
    return;
  }

  try {
    const homeDir = GLib.get_home_dir();
    const dbPaths = [
      `${homeDir}/.var/app/io.github.alainm23.planify/data/io.github.alainm23.planify/database.db`,
    ];

    let dbPath = null;
    for (const path of dbPaths) {
      if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
        dbPath = path;
        break;
      }
    }

    if (!dbPath) {
      const notFoundItem = new PopupMenu.PopupMenuItem(
        "Database file not found"
      );
      notFoundItem.setSensitive(false);
      button.menu.addMenuItem(notFoundItem);
      taskItems.push(notFoundItem);
      return;
    }

    const headerItem = new PopupMenu.PopupMenuItem("Today's Tasks");
    headerItem.setSensitive(false);
    headerItem.actor.add_style_class_name("tasks-header");
    button.menu.addMenuItem(headerItem);
    taskItems.push(headerItem);

    const separator = new PopupMenu.PopupSeparatorMenuItem();
    button.menu.addMenuItem(separator);
    taskItems.push(separator);

    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];

    const sqlQuery = `
      SELECT i.*, l.name as label_name, l.color as label_color 
      FROM Items i 
      LEFT JOIN Labels l ON i.labels = l.id 
      WHERE i.due LIKE '%${todayStr}%' AND i.checked = 0 AND i.is_deleted = 0 
      ORDER BY i.day_order ASC;
    `;

    try {
      let [success, stdout, stderr, status] = GLib.spawn_command_line_sync(
        `sqlite3 -json "${dbPath}" "${sqlQuery}"`
      );

      if (status !== 0) {
        throw new Error(`SQLite command failed: ${ByteArray.toString(stderr)}`);
      }

      const contents = stdout;

      if (success) {
        let tasksData = [];
        const contentsStr = ByteArray.toString(contents).trim();

        if (contentsStr.length > 0) {
          tasksData = JSON.parse(contentsStr);

          if (tasksData.length > 0) {
            log(
              `Found ${tasksData.length} tasks for today: ${JSON.stringify(
                tasksData
              )}`
            );
          } else {
            log("No tasks found for today");
          }
        }

        if (tasksData.length > 0) {
          tasksData.forEach((task) => {
            const title = task.content || task.title || "Unknown Task";
            const id = task.id || "";
            const labelName = task.label_name || "";
            const labelColor = task.label_color || "";
            log(`Task: ${title}, Label: ${labelName}, Color: ${labelColor}`);

            const taskItem = new PopupMenu.PopupMenuItem(title);

            if (labelName && labelColor) {
              const containerBox = new St.BoxLayout({
                vertical: false,
              });

              const labelBox = new St.BoxLayout({
                style_class: "label-box",
              });

              const labelText = new St.Label({
                text: labelName,
                style_class: `label-text label-${labelColor}`,
              });

              labelBox.add_child(labelText);

              const titleBox = new St.BoxLayout();

              const titleLabel = new St.Label({
                text: title,
              });

              titleBox.add_child(titleLabel);

              containerBox.add_child(labelBox);
              containerBox.add_child(titleBox);

              try {
                if (taskItem.label) {
                  taskItem.remove_child(taskItem.label);
                  taskItem.add_child(containerBox);
                } else if (taskItem.actor) {
                  taskItem.actor.remove_all_children();
                  taskItem.actor.add_child(containerBox);
                }
              } catch (e) {
                log(`Error updating task item UI: ${e.message}`);

                taskItem.add_child(containerBox);
              }

              taskItem.add_style_class_name(`label-${labelColor}`);

              log(
                `Added label ${labelName} with color ${labelColor} to task ${title}`
              );
            }

            taskItem.connect("activate", () => {
              _showTaskDetailsPopup(task);
            });

            button.menu.addMenuItem(taskItem);
            taskItems.push(taskItem);
          });
        } else {
          const noTasksItem = new PopupMenu.PopupMenuItem("No tasks for today");
          noTasksItem.setSensitive(false);
          button.menu.addMenuItem(noTasksItem);
          taskItems.push(noTasksItem);
        }
      } else {
        throw new Error("Failed to read query results");
      }
    } catch (sqlError) {
      log(`SQL query error: ${sqlError.message}`);
    } finally {
    }

    const endSeparator = new PopupMenu.PopupSeparatorMenuItem();
    button.menu.addMenuItem(endSeparator);
    taskItems.push(endSeparator);

    const refreshItem = new PopupMenu.PopupMenuItem("Refresh Tasks");
    refreshItem.connect("activate", _getTodayTasks);
    button.menu.addMenuItem(refreshItem);
    taskItems.push(refreshItem);
  } catch (e) {
    log(`Error getting tasks: ${e.message}`);
    const errorItem = new PopupMenu.PopupMenuItem(`Error: ${e.message}`);
    errorItem.setSensitive(false);
    button.menu.addMenuItem(errorItem);
    taskItems.push(errorItem);
  }

  if (refreshTimeout) {
    GLib.source_remove(refreshTimeout);
  }

  refreshTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 300, () => {
    _getTodayTasks();
    return GLib.SOURCE_CONTINUE;
  });
}

function _showTaskDetailsPopup(task) {
  const title = task.content || task.title || "Unknown Task";
  const description = task.description || "No description available";
  const id = task.id || "";
  const labelName = task.label_name || "";
  const labelColor = task.label_color || "";

  log(`Showing details for task: ${title}`);

  const monitor = Main.layoutManager.primaryMonitor;

  const modalBackground = new St.Widget({
    style_class: "task-modal-background",
    reactive: true,
    x: 0,
    y: 0,
    width: monitor.width,
    height: monitor.height,
  });

  const modal = new St.BoxLayout({
    style_class: "task-modal",
    vertical: true,
    width: Math.min(600, monitor.width * 0.8),
    height: Math.min(400, monitor.height * 0.8),
    x_align: Clutter.ActorAlign.CENTER,
    y_align: Clutter.ActorAlign.CENTER,
  });

  modal.set_position(
    Math.floor(monitor.width / 2 - modal.width / 2),
    Math.floor(monitor.height / 2 - modal.height / 2)
  );

  const headerBox = new St.BoxLayout({
    style_class: "task-modal-header",
  });

  if (labelName && labelColor) {
    const labelBox = new St.BoxLayout({
      style_class: "label-box modal-label",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      width: 70,
    });

    const labelText = new St.Label({
      text: labelName,
      style_class: `label-text label-${labelColor}`,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    labelBox.add_child(labelText);
    headerBox.add_child(labelBox);
  }

  const titleLabel = new St.Label({
    text: title,
    style_class: "task-modal-title",
    x_expand: true,
  });
  headerBox.add_child(titleLabel);

  const closeButton = new St.Button({
    style_class: "task-modal-close-button",
    child: new St.Icon({
      icon_name: "window-close-symbolic",
      icon_size: 16,
    }),
  });

  closeButton.connect("clicked", () => {
    Main.uiGroup.remove_child(modalBackground);
    modalBackground.destroy();
  });

  headerBox.add_child(closeButton);
  modal.add_child(headerBox);

  const separator = new St.Widget({
    style_class: "task-modal-separator",
    height: 1,
  });
  modal.add_child(separator);

  const contentBox = new St.BoxLayout({
    style_class: "task-modal-content",
    vertical: true,
    x_expand: true,
    y_expand: true,
  });

  const descriptionLabel = new St.Label({
    text: description,
    style_class: "task-modal-description",
  });

  descriptionLabel.clutter_text.line_wrap = true;
  descriptionLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

  contentBox.add_child(descriptionLabel);
  modal.add_child(contentBox);

  const footerBox = new St.BoxLayout({
    style_class: "task-modal-footer",
    x_align: Clutter.ActorAlign.END,
  });

  const openButton = new St.Button({
    style_class: "task-modal-button",
    label: "Open in Planify",
  });

  openButton.connect("clicked", () => {
    Main.uiGroup.remove_child(modalBackground);
    modalBackground.destroy();

    if (id) {
      Util.spawnCommandLine(
        `flatpak run io.github.alainm23.planify --open-task ${id}`
      );
    } else {
      _showPlanner();
    }
  });

  footerBox.add_child(openButton);
  modal.add_child(footerBox);

  modalBackground.add_child(modal);

  modalBackground.connect("button-press-event", (actor, event) => {
    const [x, y] = event.get_coords();
    const modalBox = modal.get_allocation_box();

    if (
      x < modalBox.x1 ||
      x > modalBox.x2 ||
      y < modalBox.y1 ||
      y > modalBox.y2
    ) {
      Main.uiGroup.remove_child(modalBackground);
      modalBackground.destroy();
      return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_PROPAGATE;
  });

  Main.uiGroup.add_child(modalBackground);

  const signalId = global.stage.connect("key-press-event", (actor, event) => {
    if (event.get_key_symbol() === Clutter.KEY_Escape) {
      global.stage.disconnect(signalId);
      Main.uiGroup.remove_child(modalBackground);
      modalBackground.destroy();
      return Clutter.EVENT_STOP;
    }
    return Clutter.EVENT_PROPAGATE;
  });
}

function init() {
  log(`Initializing ${Me.metadata.name} version ${Me.metadata.version}`);

  return;
}

function enable() {
  log(`Enabling ${Me.metadata.name} version ${Me.metadata.version}`);

  button = new PanelMenu.Button(0.0, `${Me.metadata.name}`, false);

  let icon = new St.Icon({
    style_class: "planner-icon",
    icon_size: 16,
  });

  button.add_child(icon);

  const openPlanifyItem = new PopupMenu.PopupMenuItem("Open Planify");
  openPlanifyItem.connect("activate", _showPlanner);
  button.menu.addMenuItem(openPlanifyItem);

  button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

  Main.panel.addToStatusArea(`${Me.metadata.name}`, button, 0, "right");

  _getTodayTasks();
}

function disable() {
  log(`Disabling ${Me.metadata.name} version ${Me.metadata.version}`);

  if (refreshTimeout) {
    GLib.source_remove(refreshTimeout);
    refreshTimeout = null;
  }

  taskItems = [];

  if (button) {
    button.destroy();
    button = null;
  }
}
