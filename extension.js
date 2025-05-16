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
const MessageTray = imports.ui.messageTray;

const Me = ExtensionUtils.getCurrentExtension();

// Configuration constants
const CONFIG = {
  PLANIFY_CMD: "flatpak run io.github.alainm23.planify",
  DB_PATHS: [
    `${GLib.get_home_dir()}/.var/app/io.github.alainm23.planify/data/io.github.alainm23.planify/database.db`,
  ],
  REFRESH_INTERVAL: 60, // seconds
  NOTIFICATION: {
    ENABLED: true,
    MINUTES_BEFORE: 5, // minutes before due time to send notification
    CHECK_INTERVAL: 60, // seconds between notification checks
  },
};

// Global state
let button = null;
let refreshTimeout = null;
let notificationTimeout = null;
let taskItems = [];
let notifiedTaskIds = new Set(); // Keep track of tasks we've already notified about

// =====================================================================
// Utility Functions
// =====================================================================

/**
 * Creates and shows a notification
 * @param {string} title - The notification title
 * @param {string} body - The notification body text
 * @param {string} taskId - The ID of the task for the notification
 */
function _showNotification(title, body, taskId) {
  const source = new MessageTray.Source(Me.metadata.name, "task-due");
  Main.messageTray.add(source);

  const notification = new MessageTray.Notification(source, title, body);
  notification.setTransient(false);
  notification.setUrgency(MessageTray.Urgency.HIGH);

  // Add Open Planify action
  notification.addAction("Open Planify", () => {
    _showPlanner();
  });

  // Add Mark as Done action
  notification.addAction("Mark as Done", () => {
    if (taskId) {
      const updateQuery = `UPDATE Items SET checked = 1 WHERE id = '${taskId}';`;
      const result = _executeQuery(updateQuery);

      if (result.success) {
        log(`Task marked as done from notification: ${title}`);
        _getTodayTasks();
      } else {
        log(`Error updating task from notification: ${result.error}`);
      }
    }
  });

  source.showNotification(notification);

  // Add to notified tasks set
  notifiedTaskIds.add(taskId);
}

/**
 * Checks for upcoming tasks and sends notifications
 */
function _checkUpcomingTasks() {
  if (!CONFIG.NOTIFICATION.ENABLED) {
    return;
  }

  // Get current time
  const now = new Date();

  // Calculate the time window for notifications (now + notification window)
  const notificationWindow = new Date(
    now.getTime() + CONFIG.NOTIFICATION.MINUTES_BEFORE * 60 * 1000
  );

  // Format dates for SQL query
  const nowStr = now.toISOString();
  const windowStr = notificationWindow.toISOString();

  // Query for tasks due in the notification window that haven't been completed
  const sqlQuery = `
    SELECT i.*, l.name as label_name, l.color as label_color 
    FROM Items i 
    LEFT JOIN Labels l ON i.labels = l.id 
    WHERE i.due BETWEEN '${nowStr}' AND '${windowStr}' 
    AND i.checked = 0 AND i.is_deleted = 0;
  `;

  const result = _executeQuery(sqlQuery);

  if (!result.success) {
    log(`Error checking upcoming tasks: ${result.error}`);
    return;
  }

  const upcomingTasks = result.data || [];

  // Send notifications for tasks that haven't been notified yet
  upcomingTasks.forEach((task) => {
    const taskId = task.id || "";
    const title = task.content || task.title || "Unknown Task";

    // Skip if we've already notified about this task
    if (notifiedTaskIds.has(taskId)) {
      return;
    }

    // Parse the due date
    const dueDate = new Date(task.due);
    const dueTimeStr = dueDate.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    // Create notification message
    const notificationTitle = `Task Due Soon: ${title}`;
    const notificationBody = `This task is due at ${dueTimeStr} (in ${CONFIG.NOTIFICATION.MINUTES_BEFORE} minutes)`;

    _showNotification(notificationTitle, notificationBody, taskId);
    log(`Sent notification for task: ${title} due at ${dueTimeStr}`);
  });

  // Schedule the next check
  _scheduleNotificationCheck();
}

/**
 * Schedules the next notification check
 */
function _scheduleNotificationCheck() {
  // Clear any existing timeout
  if (notificationTimeout) {
    GLib.source_remove(notificationTimeout);
    notificationTimeout = null;
  }

  // Set up a new timeout
  notificationTimeout = GLib.timeout_add_seconds(
    GLib.PRIORITY_DEFAULT,
    CONFIG.NOTIFICATION.CHECK_INTERVAL,
    () => {
      _checkUpcomingTasks();
      return GLib.SOURCE_CONTINUE;
    }
  );
}

/**
 * Clears the notification timeout
 */
function _clearNotificationTimeout() {
  if (notificationTimeout) {
    GLib.source_remove(notificationTimeout);
    notificationTimeout = null;
  }
}

/**
 * Opens the Planify application
 */
function _showPlanner() {
  Util.spawnCommandLine(CONFIG.PLANIFY_CMD);
}

/**
 * Checks if sqlite3 is installed on the system
 * @returns {boolean} True if sqlite3 is installed
 */
function _checkSqliteInstalled() {
  try {
    let [result, stdout, stderr, status] =
      GLib.spawn_command_line_sync("which sqlite3");
    return status === 0;
  } catch (e) {
    log(`Error checking sqlite: ${e}`);
    return false;
  }
}

/**
 * Finds the Planify database path
 * @returns {string|null} The database path or null if not found
 */
function _findDatabasePath() {
  for (const path of CONFIG.DB_PATHS) {
    if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
      return path;
    }
  }
  return null;
}

/**
 * Executes an SQL query on the Planify database
 * @param {string} query - The SQL query to execute
 * @returns {Object} Result object with success, data, and error properties
 */
function _executeQuery(query) {
  const result = { success: false, data: null, error: null };

  if (!_checkSqliteInstalled()) {
    result.error = "sqlite3 not installed";
    return result;
  }

  const dbPath = _findDatabasePath();
  if (!dbPath) {
    result.error = "Database not found";
    return result;
  }

  try {
    const [success, stdout, stderr, status] = GLib.spawn_command_line_sync(
      `sqlite3 -json "${dbPath}" "${query}"`
    );

    if (status !== 0) {
      result.error = ByteArray.toString(stderr);
      return result;
    }

    const contentsStr = ByteArray.toString(stdout).trim();
    result.success = true;

    if (contentsStr.length > 0) {
      try {
        result.data = JSON.parse(contentsStr);
      } catch (e) {
        result.data = contentsStr;
      }
    }

    return result;
  } catch (e) {
    result.error = `${e}`;
    return result;
  }
}

/**
 * Retrieves and displays today's tasks in the menu
 */
function _getTodayTasks() {
  // Clear existing items
  taskItems.forEach((item) => {
    item.destroy();
  });
  taskItems = [];

  // Check if sqlite3 is installed
  if (!_checkSqliteInstalled()) {
    _showSqliteNotInstalledMessage();
    return;
  }

  // Add header for tasks
  const headerItem = new PopupMenu.PopupMenuItem("Today's Tasks");
  headerItem.setSensitive(false);
  headerItem.actor.add_style_class_name("tasks-header");
  button.menu.addMenuItem(headerItem);
  taskItems.push(headerItem);

  const separator = new PopupMenu.PopupSeparatorMenuItem();
  button.menu.addMenuItem(separator);
  taskItems.push(separator);

  // Get today's date in YYYY-MM-DD format
  const today = new Date();
  const todayStr = today.toLocaleDateString("sv-SE");

  // Query for today's uncompleted tasks
  const sqlQuery = `
    SELECT i.*, l.name as label_name, l.color as label_color 
    FROM Items i 
    LEFT JOIN Labels l ON i.labels = l.id 
    WHERE i.due LIKE '%${todayStr}%' AND i.checked = 0 AND i.is_deleted = 0 
    ORDER BY i.day_order ASC;
  `;

  const result = _executeQuery(sqlQuery);

  if (!result.success) {
    _showErrorMessage(`Error loading tasks: ${result.error}`);
    return;
  }

  const tasksData = result.data || [];

  if (tasksData.length > 0) {
    log(`Found ${tasksData.length} tasks for today`);
    _displayTasks(tasksData);
  } else {
    log("No tasks found for today");
    _showNoTasksMessage();
  }

  // Add separator and refresh button
  const endSeparator = new PopupMenu.PopupSeparatorMenuItem();
  button.menu.addMenuItem(endSeparator);
  taskItems.push(endSeparator);

  const refreshItem = new PopupMenu.PopupMenuItem("Refresh Tasks");
  refreshItem.connect("activate", _getTodayTasks);
  button.menu.addMenuItem(refreshItem);
  taskItems.push(refreshItem);

  // Set up auto-refresh
  if (refreshTimeout) {
    GLib.source_remove(refreshTimeout);
  }

  refreshTimeout = GLib.timeout_add_seconds(
    GLib.PRIORITY_DEFAULT,
    CONFIG.REFRESH_INTERVAL,
    () => {
      _getTodayTasks();
      return GLib.SOURCE_CONTINUE;
    }
  );
}

/**
 * Shows a message that sqlite3 is not installed
 */
function _showSqliteNotInstalledMessage() {
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
}

/**
 * Shows an error message in the menu
 * @param {string} message - The error message to display
 */
function _showErrorMessage(message) {
  const errorItem = new PopupMenu.PopupMenuItem(message);
  errorItem.setSensitive(false);
  button.menu.addMenuItem(errorItem);
  taskItems.push(errorItem);
  log(message);
}

/**
 * Shows a message when no tasks are found
 */
function _showNoTasksMessage() {
  const noTasksItem = new PopupMenu.PopupMenuItem("No tasks for today");
  noTasksItem.setSensitive(false);
  button.menu.addMenuItem(noTasksItem);
  taskItems.push(noTasksItem);
}

/**
 * Displays tasks in the menu
 * @param {Array} tasksData - Array of task objects
 */
function _displayTasks(tasksData) {
  tasksData.forEach((task) => {
    const title = task.content || task.title || "Unknown Task";
    const labelName = task.label_name || "";
    const labelColor = task.label_color || "";

    const taskItem = new PopupMenu.PopupMenuItem(title);

    // Create a container for the task item
    const taskBox = new St.BoxLayout({
      style_class: "task-item-box",
      x_expand: true,
    });

    // Add label if available
    if (labelName && labelColor) {
      const labelBox = new St.BoxLayout({
        style_class: "label-box",
      });

      const labelText = new St.Label({
        text: labelName,
        style_class: `label-text label-${labelColor}`,
      });

      labelBox.add_child(labelText);
      taskBox.add_child(labelBox);
    }

    // Add task title
    const titleLabel = new St.Label({
      text: title,
      style_class: "task-title",
      x_expand: true,
    });

    // Set text wrapping for long titles
    titleLabel.clutter_text.line_wrap = true;
    titleLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

    taskBox.add_child(titleLabel);

    // Replace the default label with our custom box
    taskItem.actor.remove_child(taskItem.label);
    taskItem.actor.add_child(taskBox);

    taskItem.connect("activate", () => {
      _showTaskDetailsPopup(task);
    });

    button.menu.addMenuItem(taskItem);
    taskItems.push(taskItem);
  });
}

/**
 * Shows a popup with task details and action buttons
 * @param {Object} task - The task object to display
 */
function _showTaskDetailsPopup(task) {
  // Extract task properties
  const title = task.content || task.title || "Unknown Task";
  const description = task.description || "No description available";
  const id = task.id || "";
  const labelName = task.label_name || "";
  const labelColor = task.label_color || "";

  log(`Showing details for task: ${title}`);

  // Create modal components
  const { modalBackground, modal } = _createModalStructure();

  // Add header with title and close button
  const headerBox = _createModalHeader(modal, title, labelName, labelColor);

  // Add separator
  _addSeparator(modal);

  // Add content with description
  _addModalContent(modal, description);

  // Add footer with action buttons
  _addModalFooter(modal, modalBackground, id, title);

  // Add modal to screen and configure event handling
  _setupModalEvents(modalBackground, modal);
}

/**
 * Creates the basic modal structure
 * @returns {Object} Object containing modalBackground and modal elements
 */
function _createModalStructure() {
  const monitor = Main.layoutManager.primaryMonitor;

  // Create background overlay
  const modalBackground = new St.Widget({
    style_class: "task-modal-background",
    reactive: true,
    x: 0,
    y: 0,
    width: monitor.width,
    height: monitor.height,
  });

  // Create modal container
  const modal = new St.BoxLayout({
    style_class: "task-modal",
    vertical: true,
    width: Math.min(500, monitor.width * 0.8),
    height: Math.min(200, monitor.height * 0.8),
    x_align: Clutter.ActorAlign.CENTER,
    y_align: Clutter.ActorAlign.CENTER,
  });

  // Position the modal in the center of the screen
  modal.set_position(
    Math.floor(monitor.width / 2 - modal.width / 2),
    Math.floor(monitor.height / 2 - modal.height / 2)
  );

  modalBackground.add_child(modal);

  return { modalBackground, modal };
}

/**
 * Creates and adds the modal header with title and close button
 * @param {Object} modal - The modal container
 * @param {string} title - The task title
 * @param {string} labelName - The label name (if any)
 * @param {string} labelColor - The label color (if any)
 * @returns {Object} The header box element
 */
function _createModalHeader(modal, title, labelName, labelColor) {
  const headerBox = new St.BoxLayout({
    style_class: "task-modal-header",
  });

  // Add label if available
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

  // Add title
  const titleLabel = new St.Label({
    text: title,
    style_class: "task-modal-title",
    x_expand: true,
  });
  headerBox.add_child(titleLabel);

  // Add close button
  const closeButton = _createCloseButton();
  headerBox.add_child(closeButton);

  modal.add_child(headerBox);
  return headerBox;
}

/**
 * Creates a close button for the modal
 * @returns {Object} The close button element
 */
function _createCloseButton() {
  const closeButton = new St.Button({
    style_class: "task-modal-close-button",
    child: new St.Icon({
      icon_name: "window-close-symbolic",
      icon_size: 16,
    }),
  });

  closeButton.connect("clicked", () => {
    const modalBackground = closeButton.get_parent().get_parent().get_parent();
    Main.layoutManager.removeChrome(modalBackground);
    modalBackground.destroy();
  });

  return closeButton;
}

/**
 * Adds a separator to the modal
 * @param {Object} modal - The modal container
 */
function _addSeparator(modal) {
  const separator = new St.Widget({
    style_class: "task-modal-separator",
    height: 1,
  });
  modal.add_child(separator);
}

/**
 * Adds content with description to the modal
 * @param {Object} modal - The modal container
 * @param {string} description - The task description
 */
function _addModalContent(modal, description) {
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
}

/**
 * Adds footer with action buttons to the modal
 * @param {Object} modal - The modal container
 * @param {Object} modalBackground - The modal background
 * @param {string} id - The task ID
 * @param {string} title - The task title
 */
function _addModalFooter(modal, modalBackground, id, title) {
  const footerBox = new St.BoxLayout({
    style_class: "task-modal-footer",
    x_align: Clutter.ActorAlign.END,
    x_expand: true,
  });

  // Add Done button
  const doneButton = _createDoneButton(modalBackground, id, title);
  footerBox.add_child(doneButton);

  // Add Open Planify button
  const openButton = _createOpenPlanifyButton(modalBackground, id);
  footerBox.add_child(openButton);

  modal.add_child(footerBox);
}

/**
 * Creates a Done button that marks the task as completed
 * @param {Object} modalBackground - The modal background
 * @param {string} id - The task ID
 * @param {string} title - The task title
 * @returns {Object} The Done button element
 */
function _createDoneButton(modalBackground, id, title) {
  const doneButton = new St.Button({
    style_class: "task-modal-button task-done-button",
    label: "Done",
  });

  doneButton.connect("clicked", () => {
    if (id) {
      const updateQuery = `UPDATE Items SET checked = 1 WHERE id = '${id}';`;
      const result = _executeQuery(updateQuery);

      if (result.success) {
        log(`Task marked as done: ${title}`);
        _getTodayTasks();
      } else {
        log(`Error updating task: ${result.error}`);
      }
    }

    Main.layoutManager.removeChrome(modalBackground);
    modalBackground.destroy();
  });

  return doneButton;
}

/**
 * Creates an Open Planify button
 * @param {Object} modalBackground - The modal background
 * @param {string} id - The task ID
 * @returns {Object} The Open Planify button element
 */
function _createOpenPlanifyButton(modalBackground, id) {
  const openButton = new St.Button({
    style_class: "task-modal-button",
    label: "Open Planify",
  });

  openButton.connect("clicked", () => {
    Main.layoutManager.removeChrome(modalBackground);
    modalBackground.destroy();
    _showPlanner();
  });

  return openButton;
}

/**
 * Sets up event handling for the modal
 * @param {Object} modalBackground - The modal background
 * @param {Object} modal - The modal container
 */
function _setupModalEvents(modalBackground, modal) {
  // Handle clicks outside the modal
  modalBackground.connect("button-press-event", (actor, event) => {
    const [x, y] = event.get_coords();
    const modalBox = modal.get_allocation_box();

    if (
      x < modalBox.x1 ||
      x > modalBox.x2 ||
      y < modalBox.y1 ||
      y > modalBox.y2
    ) {
      Main.layoutManager.removeChrome(modalBackground);
      modalBackground.destroy();
      return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_PROPAGATE;
  });

  // Add to chrome to make it appear above other windows
  Main.layoutManager.addChrome(modalBackground, {
    affectsInputRegion: true,
    trackFullscreen: true,
  });

  // Handle Escape key to close the modal
  const signalId = global.stage.connect("key-press-event", (actor, event) => {
    if (event.get_key_symbol() === Clutter.KEY_Escape) {
      global.stage.disconnect(signalId);
      Main.layoutManager.removeChrome(modalBackground);
      modalBackground.destroy();
      return Clutter.EVENT_STOP;
    }
    return Clutter.EVENT_PROPAGATE;
  });
}

// =====================================================================
// Extension Lifecycle Functions
// =====================================================================

/**
 * Initialize the extension
 * @returns {void}
 */
function init() {
  log(`Initializing ${Me.metadata.name} version ${Me.metadata.version}`);
  return;
}

/**
 * Enable the extension - called when the extension is enabled
 * @returns {void}
 */
function enable() {
  log(`Enabling ${Me.metadata.name} version ${Me.metadata.version}`);

  // Create the panel button
  _createPanelButton();

  // Create initial menu items
  _createMenuItems();

  // Add the button to the panel
  Main.panel.addToStatusArea(`${Me.metadata.name}`, button, 0, "right");

  // Load tasks
  _getTodayTasks();

  // Start notification system
  if (CONFIG.NOTIFICATION.ENABLED) {
    // Clear notification tracking
    notifiedTaskIds.clear();

    // Do an initial check for upcoming tasks
    _checkUpcomingTasks();

    log(
      `Notification system enabled, checking every ${CONFIG.NOTIFICATION.CHECK_INTERVAL} seconds`
    );
  }
}

/**
 * Disable the extension - called when the extension is disabled
 * @returns {void}
 */
function disable() {
  log(`Disabling ${Me.metadata.name} version ${Me.metadata.version}`);

  // Clear the refresh timeout
  _clearRefreshTimeout();

  // Clear the notification timeout
  _clearNotificationTimeout();

  // Clear notification tracking
  notifiedTaskIds.clear();

  // Clear task items
  taskItems = [];

  // Destroy the button
  if (button) {
    button.destroy();
    button = null;
  }
}

/**
 * Creates the panel button with icon
 * @private
 */
function _createPanelButton() {
  button = new PanelMenu.Button(0.0, `${Me.metadata.name}`, false);

  const icon = new St.Icon({
    style_class: "planner-icon",
    icon_size: 16,
  });

  button.add_child(icon);
}

/**
 * Creates the initial menu items
 * @private
 */
function _createMenuItems() {
  // Add Open Planify item
  const openPlanifyItem = new PopupMenu.PopupMenuItem("Open Planify");
  openPlanifyItem.connect("activate", _showPlanner);
  button.menu.addMenuItem(openPlanifyItem);

  // Add Test Notification item
  const testNotificationItem = new PopupMenu.PopupMenuItem("Test Notification");
  testNotificationItem.connect("activate", _showTestNotification);
  button.menu.addMenuItem(testNotificationItem);

  // Add separator
  button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
}

/**
 * Shows a test notification for debugging purposes
 */
function _showTestNotification() {
  const testTaskId = `test-${Date.now()}`;
  const now = new Date();
  const dueDate = new Date(
    now.getTime() + CONFIG.NOTIFICATION.MINUTES_BEFORE * 60 * 1000
  );
  const dueTimeStr = dueDate.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const title = "Test Task";
  const notificationTitle = `Task Due Soon: ${title}`;
  const notificationBody = `This is a test notification. Task would be due at ${dueTimeStr} (in ${CONFIG.NOTIFICATION.MINUTES_BEFORE} minutes)`;

  _showNotification(notificationTitle, notificationBody, testTaskId);
  log("Test notification sent");
}

/**
 * Clears the refresh timeout
 * @private
 */
function _clearRefreshTimeout() {
  if (refreshTimeout) {
    GLib.source_remove(refreshTimeout);
    refreshTimeout = null;
  }
}
