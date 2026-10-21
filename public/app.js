const BASE_URL =
  window.location.protocol === "file:" ||
  window.location.hostname.includes("github.io")
    ? "https://jomish-business-suite.onrender.com"
    : "";
window.API_URL = `${BASE_URL}/api`;
const API_URL = window.API_URL;
let USER_ROLE = "";
let USER_NAME = "";
window._hasActiveCashierShift = false;
window.USER_PERMISSIONS = {
  can_see_dashboard: 0,
  can_see_hr: 0,
  can_see_attendance: 1,
  can_see_sme: 0,
  can_see_pos: 0,
  can_see_secretary: 0,
  can_see_transport: 0,
};
let USER_PERMISSIONS = window.USER_PERMISSIONS;
let ENABLED_TABS = {
  dashboard: true,
  hr: true,
  attendance: true,
  sme: true,
  pos: true,
  secretary: true,
  transport: true,
  schedules: true,
  hardware: true,
  system_users: true,
};
let barcodeBuffer = "";
let lastKeyTime = Date.now();
let soldBarcodes = new Set();
let isPrinting = false;
const _printedReceiptNos = new Set();
const _productPhotoCache = new Map();

function formatDocNo(prefix, num) {
  if (!num && num !== 0) return "";
  const raw = String(num).replace(/^(INV|RCPT)[-#\s]*/i, "");
  const n = parseInt(raw, 10);
  const padded = isNaN(n) ? raw : String(n).padStart(3, "0");
  return `${prefix}${padded}`;
}
window.formatDocNo = formatDocNo;

function lazyLoadProductImages() {
  const imgs = document.querySelectorAll("img.lazy-prod-photo[data-photo-id]");
  if (!imgs.length) return;
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries, obs) => {
      entries.forEach(async (entry) => {
        if (entry.isIntersecting) {
          const img = entry.target;
          obs.unobserve(img);
          const pId = img.dataset.photoId;
          if (_productPhotoCache.has(pId)) {
            const cachedUrl = _productPhotoCache.get(pId);
            if (cachedUrl) img.src = cachedUrl;
            return;
          }
          try {
            const res = await fetchAuth(`${API_URL}/products/${pId}/photo`);
            if (res.ok) {
              const data = await res.json();
              if (data.photo_base64) {
                _productPhotoCache.set(pId, data.photo_base64);
                img.src = data.photo_base64;
              } else {
                _productPhotoCache.set(pId, null);
              }
            }
          } catch (_) {}
        }
      });
    });
    imgs.forEach((img) => observer.observe(img));
  } else {
    imgs.forEach(async (img) => {
      const pId = img.dataset.photoId;
      try {
        const res = await fetchAuth(`${API_URL}/products/${pId}/photo`);
        if (res.ok) {
          const data = await res.json();
          if (data.photo_base64) img.src = data.photo_base64;
        }
      } catch (_) {}
    });
  }
}
let GLOBAL_SHIFTS = [
  {
    id: "morning",
    label: "Morning",
    icon: "fa-solid fa-sun",
    color: "#F59E0B",
    start_time: "08:00",
    end_time: "16:00",
  },
  {
    id: "afternoon",
    label: "Afternoon",
    icon: "fa-solid fa-cloud-sun",
    color: "#6366F1",
    start_time: "16:00",
    end_time: "23:59",
  },
];
let GLOBAL_OPERATIONAL_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

// Dark mode
function applyTheme() {
  const t = localStorage.getItem("jomish_theme") || "light";
  document.documentElement.setAttribute("data-theme", t);
  if (t === "dark") {
    document.documentElement.classList.add("dark-theme");
    if (document.body) document.body.classList.add("dark-theme");
  } else {
    document.documentElement.classList.remove("dark-theme");
    if (document.body) document.body.classList.remove("dark-theme");
  }
}
applyTheme();
document.addEventListener("DOMContentLoaded", applyTheme);

// Detect Staging / Test Environment & Show Indicator Badge
(async function checkEnvironmentBadge() {
  try {
    const isStagingHost = window.location.hostname.includes("staging") || window.location.hostname.includes("test");
    const res = await fetch(`${API_URL}/system/status`).catch(() => null);
    const data = res && res.ok ? await res.json() : null;
    if (isStagingHost || (data && data.env === "staging")) {
      const b = document.getElementById("pos-staging-badge");
      if (b) b.style.display = "inline-flex";
      document.title = "[TEST] " + document.title;
    }
  } catch (e) {}
})();

function toggleTheme() {
  const current =
    document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  if (next === "dark") {
    document.documentElement.classList.add("dark-theme");
    if (document.body) document.body.classList.add("dark-theme");
  } else {
    document.documentElement.classList.remove("dark-theme");
    if (document.body) document.body.classList.remove("dark-theme");
  }
  localStorage.setItem("jomish_theme", next);
}

// ---- Global Modal Helpers ----
// These are defined at top-level so inline onclick attributes in HTML can call them directly.
function openCalModal() {
  const m = document.getElementById("cal-event-modal");
  if (!m) {
    alert("ERROR: Modal element #cal-event-modal not found!");
    return;
  }
  m.classList.remove("hidden");
  m.style.display = "flex";
  m.style.position = "fixed";
  m.style.inset = "0";
  m.style.zIndex = "99999";
  m.style.backgroundColor = "rgba(0,0,0,0.6)";
  m.style.justifyContent = "center";
  m.style.alignItems = "center";
}

function closeCalModal() {
  const m = document.getElementById("cal-event-modal");
  if (!m) return;
  m.style.cssText = "";
  m.classList.add("hidden");
}
window.openCalModal = openCalModal;
window.closeCalModal = closeCalModal;

// window.onerror override removed to allow index.html's visual error handler to catch errors.;

window.addEventListener("unhandledrejection", function (event) {
  console.error("[Jomish Promise Error]", event.reason);
});

// Utility to safely format dates — handles ISO, SQLite space format, and legacy locale strings
function formatDisplayDate(dateStr, showTime = true) {
  if (!dateStr) return "—";
  const s = String(dateStr).trim();
  if (!s || s === "null" || s === "undefined" || s === "CURRENT_DATETIME")
    return "—";

  let d;

  // Strategy 1: Direct parse — works for ISO 8601 strings with or without Z
  d = new Date(s);

  // Strategy 2: SQLite CURRENT_TIMESTAMP format "YYYY-MM-DD HH:MM:SS" → replace space with T
  if (isNaN(d.getTime()) && s.includes(" ") && !s.includes(",")) {
    d = new Date(s.replace(" ", "T"));
  }

  // Strategy 3: Try appending Z to treat as UTC (some SQLite drivers omit timezone)
  if (isNaN(d.getTime())) {
    d = new Date(s.replace(" ", "T") + "Z");
  }

  // Give up — show a dash rather than the raw ugly string
  if (isNaN(d.getTime())) return "—";

  const options = {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "Africa/Kampala", // Always display in Uganda local time
  };
  if (showTime) {
    options.hour = "2-digit";
    options.minute = "2-digit";
  }

  return d.toLocaleString("en-US", options);
}

document.addEventListener("DOMContentLoaded", () => {
  const token = localStorage.getItem("jomish_token");
  USER_ROLE = localStorage.getItem("jomish_role");
  USER_NAME = localStorage.getItem("jomish_name") || "";

  // Reveal the page now that DOM is ready (was hidden by inline auth guard in <head>)
  document.documentElement.style.visibility = "";

  try {
    const raw = localStorage.getItem("jomish_permissions");
    if (raw) USER_PERMISSIONS = JSON.parse(raw);
  } catch (e) {
    console.error("Permission parse err", e);
  }

  if (!token) {
    // Belt-and-suspenders: inline guard already redirected, but just in case
    window.location.replace("login.html");
    return;
  }

  // Set UI based on Role
  const _uip = document.querySelector(".user-info p");
  if (_uip)
    _uip.innerText = `Logged in as: ${localStorage.getItem("jomish_name")} (${USER_ROLE})`;
  // JomishPOS topbar
  const _tbUser = document.getElementById("pos-topbar-username");
  if (_tbUser)
    _tbUser.textContent = `${localStorage.getItem("jomish_name") || "User"} (${USER_ROLE})`;
  initNavigation();
  enforceRBAC();
  autoRedirect();

  // Fade out & remove the skeleton loader once the real app is ready
  const skeleton = document.getElementById("app-skeleton");
  if (skeleton) {
    skeleton.classList.add("fade-out");
    setTimeout(() => {
      if (skeleton.parentNode) skeleton.remove();
    }, 450);
  }

  // Load system printers into dropdown (Electron only)
  // Initialize Printer Selection Input
  setTimeout(() => {
    const input = document.getElementById("system-printer-select");
    const dataList = document.getElementById("printer-list");
    if (!input) return;

    const saved = localStorage.getItem("jomish_system_printer");
    if (saved) input.value = saved;

    input.addEventListener("change", (e) => {
      localStorage.setItem("jomish_system_printer", e.target.value.trim());
      showToast("System printer updated", "success");
    });

    if (window.electronAPI && window.electronAPI.getPrinters && dataList) {
      window.electronAPI
        .getPrinters()
        .then((printers) => {
          printers.forEach((p) => {
            const opt = document.createElement("option");
            opt.value = p.name;
            dataList.appendChild(opt);
          });
        })
        .catch((e) => console.error("Failed to load printers:", e));
    }

    // Restore saved network printer settings
    const savedIp = localStorage.getItem("jomish_printer_ip");
    const savedPort = localStorage.getItem("jomish_printer_port");
    const ipInput = document.getElementById("network-printer-ip");
    const portInput = document.getElementById("network-printer-port");
    if (ipInput && savedIp) {
      ipInput.value = savedIp;
      updateNetworkPrinterStatus(savedIp);
    }
    if (portInput && savedPort) portInput.value = savedPort;
  }, 2000);

  // Ultimate DOM-level Webview Tamer:
  // When ANY host input gets focus (cursor placed inside), we completely strip pointer-events and focus from all webviews.
  // This physically blocks them from fighting back for the keyboard.
  document.addEventListener("focusin", (e) => {
    if (
      e.target.tagName === "INPUT" ||
      e.target.tagName === "TEXTAREA" ||
      e.target.tagName === "SELECT"
    ) {
      document.querySelectorAll("webview").forEach((wv) => {
        wv.style.pointerEvents = "none";
        wv.blur();
      });
      if (window.electronAPI && window.electronAPI.forceFocus) {
        window.electronAPI.forceFocus();
      }
      // Double enforce the focus on the input to override any race conditions
      setTimeout(() => {
        if (document.activeElement !== e.target) e.target.focus();
      }, 10);
    }
  });

  // Webview Tamer - mousedown edition:
  // ONLY enable pointer-events when user clicks directly on the [data-webview-zone] wrapper div.
  // Clicking the header bar, reload button, or anywhere outside does NOT activate the webview.
  // This prevents the webview from permanently stealing keyboard input.
  document.addEventListener("mousedown", (e) => {
    const zone = e.target.closest("[data-webview-zone]");
    if (zone) {
      // User clicked inside the actual webview rendering area — allow interaction
      const wv = zone.querySelector("webview");
      if (wv) wv.style.pointerEvents = "auto";
    } else {
      // Clicked anywhere outside the webview zone — kill all webview pointer-events
      document.querySelectorAll("webview").forEach((wv) => {
        wv.style.pointerEvents = "none";
        wv.blur();
      });
      if (window.electronAPI && window.electronAPI.forceFocus) {
        window.electronAPI.forceFocus();
      } else {
        window.focus();
        document.body.focus();
      }
    }
  });

  initSockets();
  // JomishPOS: boot straight into the POS terminal
  const allSections = document.querySelectorAll(".main-content .view-section");
  allSections.forEach((s) => s.classList.remove("active"));
  const posSection = document.getElementById("pos-terminal");
  if (posSection) {
    posSection.classList.add("active");
  }

  // If this is the global TECH user — show Tech Hub tab, redirect there, hide normal tabs
  const _techUser = (localStorage.getItem("jomish_prefix") || "").toLowerCase();
  const _isTechUser =
    (!_techUser || _techUser === "public") && (USER_ROLE || "").toUpperCase() === "TECH";
  if (_isTechUser) {
    const techBtn = document.getElementById("pos-nav-tech");
    if (techBtn) {
      techBtn.classList.add("pos-tab"); // add styling only for real tech logins
      techBtn.style.display = "flex";
    }
    // Hide company-specific tabs
    [
      "pos-nav-register",
      "pos-nav-stock",
      "pos-nav-lowstock",
      "pos-nav-expenses",
      "pos-nav-credits",
      "pos-nav-finance",
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    });
    setTimeout(() => {
      switchPOSView("tech");
    }, 300);
  } else {
    setTimeout(() => {
      const _role = (USER_ROLE || "").toUpperCase();
      if (_role === "TECH") {
        switchPOSView("tech");       // Tech → Tech Hub
      } else if (_role === "CASHIER") {
        switchPOSView("register");   // Cashier → Register
      } else if (_role === "WAITER") {
        // Waiter sees Register and Pending (orders they worked on)
        [
          "pos-nav-stock",
          "pos-nav-lowstock",
          "pos-nav-expenses",
          "pos-nav-credits",
          "pos-nav-finance",
          "pos-nav-tech",
        ].forEach((id) => {
          const el = document.getElementById(id);
          if (el) {
            el.style.setProperty("display", "none", "important");
            el.classList.add("hidden");
          }
        });
        switchPOSView("register");   // Waiter → Register (place new orders)
      } else if (["CEO", "ADMIN", "MANAGER", "FINANCE MANAGER"].includes(_role)) {
        switchPOSView("stock");      // Admin-like → Inventory
      } else if (_role === "SUPERVISOR") {
        switchPOSView("register");   // Supervisor → Register
      } else if (_role === "HR") {
        switchPOSView("expenses");   // HR → Expenses
      } else {
        switchPOSView("stock");      // fallback
      }
    }, 300);
  }

  registerDevice();
  loadBrandLogo();
  loadBusinessConfig();
  loadSystemStatus();
  checkDataLossWarning();

  // Start clock manually since loadDashboard is removed
  startLiveClock();

  validateSession();
  initBarcodeAutoCalc();
  loadSoldBarcodes();
  // Scanner will start when the Attendance tab is clicked

  // Employee Handlers
  document
    .getElementById("btn-add-employee")
    ?.addEventListener("click", async () => {
      await loadRolesIntoSelect("emp-role");
      document.getElementById("add-employee-modal").classList.remove("hidden");
    });

  // Calendar Event Modal via addEventListener (required because contextIsolation=true blocks onclick)
  const _calBtn = document.getElementById("btn-add-calendar-event");
  const _calModal = document.getElementById("cal-event-modal");
  const _calCloseBtn = document.getElementById("btn-close-cal-event");

  // Log what we found so we can see in DevTools (F12)

  if (_calBtn && _calModal) {
    _calBtn.addEventListener("click", () => {
      _calModal.style.setProperty("display", "flex", "important");
      _calModal.style.setProperty("position", "fixed", "important");
      _calModal.style.setProperty("top", "0", "important");
      _calModal.style.setProperty("left", "0", "important");
      _calModal.style.setProperty("width", "100%", "important");
      _calModal.style.setProperty("height", "100%", "important");
      _calModal.style.setProperty("z-index", "99999", "important");
      _calModal.style.setProperty(
        "background-color",
        "rgba(0,0,0,0.7)",
        "important",
      );
      _calModal.style.setProperty("justify-content", "center", "important");
      _calModal.style.setProperty("align-items", "center", "important");
      _calModal.classList.remove("hidden");
    });
  } else {
    console.error(
      "[CAL ERROR] Could not find: btn=" + !!_calBtn + " modal=" + !!_calModal,
    );
  }

  if (_calCloseBtn && _calModal) {
    _calCloseBtn.addEventListener("click", () => {
      _calModal.removeAttribute("style");
      _calModal.classList.add("hidden");
    });
  }

  const formCalEvent = document.getElementById("form-cal-event");
  if (formCalEvent) {
    formCalEvent.addEventListener("submit", handleCalEventSubmit);
  }
  document
    .getElementById("btn-close-emp-modal")
    ?.addEventListener("click", () => {
      document.getElementById("add-employee-modal").classList.add("hidden");
    });
  document
    .getElementById("form-add-employee")
    ?.addEventListener("submit", handleAddEmployee);
  document
    .getElementById("btn-add-schedule")
    ?.addEventListener("click", handleAddSchedule);

  // TX Handlers
  document.getElementById("btn-add-tx")?.addEventListener("click", () => {
    document.getElementById("add-tx-modal").classList.remove("hidden");
  });
  document
    .getElementById("btn-close-tx-modal")
    ?.addEventListener("click", () => {
      document.getElementById("add-tx-modal").classList.add("hidden");
    });
  document
    .getElementById("form-add-tx")
    ?.addEventListener("submit", handleAddTx);

  // Attendance Scan Simulation
  document
    .getElementById("btn-simulate-scan")
    ?.addEventListener("click", handleScan);

  // New Feature Handlers
  document
    .getElementById("form-add-note")
    ?.addEventListener("submit", handleAddNote);

  // handleAddNotice was removed — notice board is no longer a feature
  document
    .getElementById("btn-auto-schedule")
    ?.addEventListener("click", handleAutoSchedule);

  // Branding Settings
  const btnUploadLogo = document.getElementById("btn-upload-logo");
  if (btnUploadLogo) {
    btnUploadLogo.addEventListener("click", handleLogoUpload);
  }

  initGlobalScanner();

  const btnSaveDetails = document.getElementById("btn-save-biz-details");
  if (btnSaveDetails) {
    btnSaveDetails.addEventListener("click", handleDetailsUpdate);
  }

  const btnSaveModules = document.getElementById("btn-save-modules");
  if (btnSaveModules) {
    btnSaveModules.addEventListener("click", handleSaveModulesUpdate);
  }

  const formEmailReply = document.getElementById("form-email-reply");
  if (formEmailReply) {
    formEmailReply.addEventListener("submit", handleEmailReplySubmit);
  }

  const btnDownloadAtt = document.getElementById("btn-download-attendance");
  if (btnDownloadAtt)
    btnDownloadAtt.addEventListener("click", downloadAttendancePDF);

  // User Management Modal Handlers
  const btnClosePassModal = document.getElementById("btn-close-pass-modal");
  if (btnClosePassModal)
    btnClosePassModal.addEventListener("click", () =>
      document.getElementById("set-password-modal").classList.add("hidden"),
    );

  const formSetPass = document.getElementById("form-set-password");
  if (formSetPass) formSetPass.addEventListener("submit", handleUpdateAccess);

  // Logout
  const btnLogout = document.getElementById("btn-logout");
  if (btnLogout) btnLogout.addEventListener("click", handleLogout);

  // Edit Product Modal Handlers
  const btnCloseEditProd = document.getElementById("btn-close-edit-prod");
  if (btnCloseEditProd)
    btnCloseEditProd.addEventListener("click", () => {
      document.getElementById("edit-product-modal").classList.add("hidden");
      document.getElementById("form-edit-product").reset();
      document.getElementById("edit-prod-preview").style.display = "none";
    });
  const formEditProd = document.getElementById("form-edit-product");
  if (formEditProd) formEditProd.addEventListener("submit", handleEditProduct);

  // Product Handlers
  const btnAddProd = document.getElementById("btn-add-product");
  if (btnAddProd)
    btnAddProd.addEventListener("click", () =>
      document.getElementById("add-product-modal").classList.remove("hidden"),
    );

  const btnCloseProd = document.getElementById("btn-close-prod-modal");
  if (btnCloseProd)
    btnCloseProd.addEventListener("click", () =>
      document.getElementById("add-product-modal").classList.add("hidden"),
    );

  const formAddProd = document.getElementById("form-add-product");
  if (formAddProd) formAddProd.addEventListener("submit", handleAddProduct);

  const btnGenerateBulk = document.getElementById("btn-generate-bulk");
  if (btnGenerateBulk)
    btnGenerateBulk.addEventListener("click", () =>
      window.generateBulkBarcodes(),
    );

  const btnIgnoreBarcodes = document.getElementById("btn-ignore-barcodes");
  if (btnIgnoreBarcodes)
    btnIgnoreBarcodes.addEventListener("click", () =>
      window.ignoreRemainingBarcodes(),
    );

  const btnCloseScan = document.getElementById("btn-close-scan-session");
  if (btnCloseScan)
    btnCloseScan.addEventListener("click", () => window.closeScanSession());

  // POS Search
  const posSearch = document.getElementById("pos-search");
  if (posSearch)
    posSearch.addEventListener("input", (e) => loadPOSProducts(e.target.value));

  // Inventory Search in Admin Portal
  const invSearch = document.getElementById("inventory-search");
  if (invSearch) {
    invSearch.addEventListener("input", (e) => window.filterInventory(e.target.value));
  }

  // SME Finance Search
  const smeSearch = document.getElementById("sme-search");
  if (smeSearch) {
    smeSearch.addEventListener("input", (e) => {
      const prodView = document.getElementById("sme-view-products");
      const isProdViewActive = prodView && prodView.style.display !== "none";
      if (isProdViewActive) {
        const prodInput = document.getElementById("sme-product-search");
        if (prodInput) prodInput.value = e.target.value;
        filterSmeProducts(e.target.value);
      } else {
        loadTransactions(e.target.value);
      }
    });
  }

  // Global barcode scanning is handled by initGlobalScanner() — no duplicate listener needed
  // POS Checkout Handler — opens payment panel with numpad
  const btnCheckout = document.getElementById("btn-checkout");
  const btnSendToCashier = document.getElementById("btn-send-to-cashier");
  const btnPrintInvoice = document.getElementById("btn-print-invoice") || document.getElementById("btn-waiter-invoice");
  const btnEndShift = document.getElementById("btn-end-shift");

  const _currentRole = (USER_ROLE || "").toUpperCase();
  const isWaiterLevel = _currentRole === "WAITER" || _currentRole === "SUPERVISOR";
  const shiftControls = document.getElementById("pos-shift-controls");
  if (isWaiterLevel) {
    // Waiter sends order to cashier (cannot pay)
    if (btnCheckout) btnCheckout.style.setProperty("display", "none", "important");
    if (btnSendToCashier) {
      btnSendToCashier.style.setProperty("display", "block", "important");
      btnSendToCashier.innerHTML = '<i class="fa-solid fa-paper-plane"></i> SEND TO CASHIER';
    }
    if (btnPrintInvoice) btnPrintInvoice.style.setProperty("display", "none", "important");
    if (shiftControls) shiftControls.style.setProperty("display", "none", "important");
    if (btnEndShift) btnEndShift.style.setProperty("display", "none", "important");
    const btnStartShift = document.getElementById("btn-start-shift");
    if (btnStartShift) btnStartShift.style.setProperty("display", "none", "important");
  } else if (_currentRole === "CASHIER") {
    // Cashier can pay, print invoices, and manage shifts
    if (btnCheckout) btnCheckout.style.setProperty("display", "block", "important");
    if (btnSendToCashier) btnSendToCashier.style.setProperty("display", "none", "important");
    if (btnPrintInvoice) btnPrintInvoice.style.setProperty("display", "block", "important");
    if (shiftControls) shiftControls.style.setProperty("display", "flex", "important");
    if (typeof updateCashierShiftUI === "function") updateCashierShiftUI();
  } else {
    // Admin/CEO/Manager/Tech etc. — invoice only, no direct payment, no cashier shifts
    if (btnCheckout) btnCheckout.style.setProperty("display", "none", "important");
    if (btnSendToCashier) btnSendToCashier.style.setProperty("display", "none", "important");
    if (btnPrintInvoice) btnPrintInvoice.style.setProperty("display", "block", "important");
    if (shiftControls) shiftControls.style.setProperty("display", "none", "important");
    if (btnEndShift) btnEndShift.style.setProperty("display", "none", "important");
    const btnStartShift = document.getElementById("btn-start-shift");
    if (btnStartShift) btnStartShift.style.setProperty("display", "none", "important");
  }

  if (btnSendToCashier) {
    btnSendToCashier.onclick = () => {
      submitWaiterOrder();
    };
  }

  if (btnPrintInvoice) {
    // Always use submitWaiterOrder: handles edit-mode (PUT existing order) and
    // fresh cart (new COD pending order). Both cases print a kitchen token only.
    btnPrintInvoice.onclick = () => submitWaiterOrder();
  }

  if (btnCheckout) {
    btnCheckout.addEventListener("click", async () => {
      if (posCart.length === 0) return alert("Cart is empty!");
      const _roleNow = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
      if (_roleNow === "CASHIER" && !window._hasActiveCashierShift) {
        const hasShift = await window.ensureCashierShiftActive("checkout orders");
        if (!hasShift) return;
      }
      if (_currentEditOrder && _currentEditOrder.id) {
        alert('You are editing an existing order. Use "Save Changes" to update it, or "Cancel" to exit edit mode.');
        return;
      }
      if (_roleNow === "WAITER") {
        alert("Waiters cannot collect payment. Please click 'SEND TO CASHIER'.");
        return;
      }
      const total = parseFloat(btnCheckout.getAttribute("data-total"));
      // Default payment method back to Cash every time checkout panel opens
      const pmSelect = document.getElementById("payment-method-select");
      if (pmSelect) {
        pmSelect.value = "CASH";
        if (typeof handlePaymentMethodChange === "function") handlePaymentMethodChange();
      }
      document.getElementById("pay-total").textContent =
        "UGX " + Math.round(total).toLocaleString();
      document.getElementById("pay-amount").value = "0";
      document.getElementById("pay-change").textContent = "UGX 0";
      document.getElementById("pay-change").style.color = "var(--text-muted)";
      const panel = document.getElementById("payment-panel");
      panel.classList.remove("hidden");
      // Auto-scroll to cash payment panel without scrolling the entire page
      setTimeout(() => {
        const cartContainer = document.querySelector(".pos-cart");
        if (cartContainer) {
          cartContainer.scrollTo({
            top: panel.offsetTop,
            behavior: "smooth",
          });
        } else {
          panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        const payInput = document.getElementById("pay-amount");
        if (payInput) {
          payInput.focus();
          payInput.select();
        }
      }, 100);
    });
  }

  // Keyboard Enter support on pay-amount to confirm payment
  const payAmountInputEl = document.getElementById("pay-amount");
  if (payAmountInputEl) {
    payAmountInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (_isConfirmingPayment || _isCollectingPending) return;
        const btnConfirm = document.getElementById("btn-confirm-pay");
        if (btnConfirm && btnConfirm.hasAttribute("data-pending-id")) {
          const pendingId = btnConfirm.getAttribute("data-pending-id");
          const paid = parseInt(payAmountInputEl.value) || 0;
          if (typeof collectPendingPayment === "function") {
            collectPendingPayment(pendingId, paid);
          }
        } else {
          confirmPayment();
        }
      }
    });
  }

  // Prevent mouse-wheel scroll from altering number inputs
  document.addEventListener("wheel", (e) => {
    if (document.activeElement && document.activeElement.type === "number") {
      document.activeElement.blur();
    }
  }, { passive: true });

  // Offline mode support
  function updateAppOnlineStatus() {
    let banner = document.getElementById("app-offline-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "app-offline-banner";
      banner.style.cssText =
        "display:none; background:#f59e0b; color:#fff; text-align:center; padding:8px; font-size:0.85rem; font-weight:bold; position:fixed; top:0; left:0; width:100%; z-index:99999;";
      document.body.prepend(banner);
    }
    if (!navigator.onLine) {
      banner.style.display = "block";
      if (window.OfflineDB) {
        window.OfflineDB.getPendingSyncCount().then((count) => {
          banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Offline Mode — ${count} actions pending sync`;
        });
      } else {
        banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Offline Mode`;
      }
    } else {
      banner.style.display = "none";
    }
  }
  window.updateAppOnlineStatus = updateAppOnlineStatus;

  window.addEventListener("online", () => {
    updateAppOnlineStatus();
    if (typeof syncQueuedMutations === "function") syncQueuedMutations();
  });
  window.addEventListener("offline", updateAppOnlineStatus);
  updateAppOnlineStatus();
});

function initNavigation() {

  const navBtns = document.querySelectorAll(".sidebar nav .nav-btn");

  // Only wire sidebar nav if buttons exist (not in POS-only mode)
  if (navBtns && navBtns.length > 0) {
    navBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        try {
          const targetId = btn.getAttribute("data-target");
          if (!targetId) return;

          navBtns.forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");

          const sections = document.querySelectorAll(
            ".main-content .view-section",
          );
          sections.forEach((sec) => sec.classList.remove("active"));
          const targetSection = document.getElementById(targetId);
          if (!targetSection) {
            console.error("[Jomish] Nav target section not found:", targetId);
            return;
          }
          targetSection.classList.remove("hidden");
          targetSection.classList.add("active");

          document.querySelectorAll("webview").forEach((wv) => wv.blur());
          if (window.electronAPI && window.electronAPI.forceFocus) {
            window.electronAPI.forceFocus();
          } else {
            window.focus();
            document.body.focus();
          }

          if (targetId === "dashboard") {
            loadDashboard();
          }
          if (targetId === "attendance") {
            loadAttendance();
          }
          if (targetId === "schedules") {
            if (typeof window.loadShiftTimetable === "function")
              window.loadShiftTimetable();
          }
          if (targetId === "sme-business") {
            loadTransactions();
          }
          if (targetId === "pos-terminal") {
            const _role = (USER_ROLE || "").toUpperCase();
            if (_role === "TECH") {
              switchPOSView("tech");       // Tech → Tech Hub
            } else if (_role === "CASHIER" || _role === "WAITER" || _role === "SUPERVISOR") {
              switchPOSView("register");   // Cashier / Waiter / Supervisor → Register
            } else if (["CEO", "ADMIN", "MANAGER", "FINANCE MANAGER"].includes(_role)) {
              switchPOSView("stock");      // Admin-like → Inventory
            } else if (_role === "HR") {
              switchPOSView("expenses");   // HR → Expenses
            } else {
              switchPOSView("stock");      // fallback
            }
          }
          if (targetId === "hr-mgmt") {
            loadEmployees();
            loadRoles();
            loadInventory();
            loadUserAccounts();
          }
          if (targetId === "secretary-hub") {
            loadSecretaryHub();
          }
          if (targetId === "tech-hub") {
            checkAutoStart();
            loadBrandLogo();
            loadRoles();
          }
          if (targetId === "system-users") {
            loadSystemUsers();
          }
        } catch (e) {
          console.error("[Jomish] Nav click error:", e);
        }
      });
    });
  } else {
    console.warn(
      "[Jomish] initNavigation: no sidebar nav buttons — POS-only mode.",
    );
  }

  // POS Sub-view Navigation Listeners (always wire these)
  const btnPosReg = document.getElementById("pos-nav-register");
  const btnPosPending = document.getElementById("pos-nav-pending");
  const btnPosStock = document.getElementById("pos-nav-stock");
  const btnPosExp = document.getElementById("pos-nav-expenses");
  const btnPosCredits = document.getElementById("pos-nav-credits");
  const btnPosTech = document.getElementById("pos-nav-tech");

  if (btnPosReg)
    btnPosReg.addEventListener("click", (e) => {
      e.preventDefault();
      switchPOSView("register");
    });
  if (btnPosPending)
    btnPosPending.addEventListener("click", (e) => {
      e.preventDefault();
      switchPOSView("pending");
    });
  if (btnPosStock)
    btnPosStock.addEventListener("click", (e) => {
      e.preventDefault();
      switchPOSView("stock");
    });
  const btnPosLowStock = document.getElementById("pos-nav-lowstock");
  if (btnPosLowStock)
    btnPosLowStock.addEventListener("click", (e) => {
      e.preventDefault();
      switchPOSView("low-stock");
    });
  if (btnPosExp)
    btnPosExp.addEventListener("click", (e) => {
      e.preventDefault();
      switchPOSView("expenses");
    });
  if (btnPosCredits)
    btnPosCredits.addEventListener("click", (e) => {
      e.preventDefault();
      switchPOSView("credits");
    });
  const btnPosHR = document.getElementById("pos-nav-hr");
  if (btnPosTech)
    btnPosTech.addEventListener("click", (e) => {
      e.preventDefault();
      switchPOSView("tech");
    });
  if (btnPosHR)
    btnPosHR.addEventListener("click", (e) => {
      e.preventDefault();
      switchPOSView("hr");
    });

  // POS Expense & Cash In Forms
  const formPosExp = document.getElementById("form-pos-expense");
  if (formPosExp) formPosExp.addEventListener("submit", handlePOSExpenseSubmit);
  const formPosCashIn = document.getElementById("form-pos-cashin");
  if (formPosCashIn) formPosCashIn.addEventListener("submit", handlePOSCashInSubmit);
}

function switchPOSView(viewName) {
  const _role = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
  if (_role === "WAITER" && viewName !== "register" && viewName !== "terminal" && viewName !== "pending") {
    viewName = "register";
  }
  // Hide all sub-views & reset nav button states
  document.querySelectorAll(".pos-sub-view").forEach((v) => {
    v.classList.add("hidden");
    v.style.display = "none";
  });
  // Reset nav button active style
  [
    "pos-nav-register",
    "pos-nav-pending",
    "pos-nav-stock",
    "pos-nav-lowstock",
    "pos-nav-expenses",
    "pos-nav-credits",
    "pos-nav-hr",
    "pos-nav-tech",
  ].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.classList.remove("active");
  });

  if (viewName === "terminal" || viewName === "register") {
    const el = document.getElementById("pos-register-view");
    if (el) {
      el.classList.remove("hidden");
      el.style.setProperty("display", "block", "important");
    }
    const b = document.getElementById("pos-nav-register");
    if (b) b.classList.add("active");
    loadPOSProducts();
  } else if (viewName === "pending") {
    const el = document.getElementById("pos-pending-view");
    if (el) {
      el.classList.remove("hidden");
      el.style.setProperty("display", "block", "important");
    }
    const b = document.getElementById("pos-nav-pending");
    if (b) b.classList.add("active");
    if (typeof loadPendingCOD === "function") {
      loadPendingCOD(true);
    }
  } else if (viewName === "stock") {
    const el = document.getElementById("pos-stock-view");
    if (el) {
      el.classList.remove("hidden");
      el.style.setProperty("display", "block", "important");
    }
    const b = document.getElementById("pos-nav-stock");
    if (b) b.classList.add("active");
    if (window.setInventoryFilterTab) window.setInventoryFilterTab("all");
    loadInventory();
  } else if (viewName === "low-stock" || viewName === "lowstock") {
    const el = document.getElementById("pos-stock-view");
    if (el) {
      el.classList.remove("hidden");
      el.style.setProperty("display", "block", "important");
    }
    const b = document.getElementById("pos-nav-lowstock");
    if (b) b.classList.add("active");
    if (window.setInventoryFilterTab) window.setInventoryFilterTab("low");
    loadInventory();
  } else if (viewName === "expenses") {
    const el = document.getElementById("pos-expenses-view");
    if (el) {
      el.classList.remove("hidden");
      el.style.setProperty("display", "block", "important");
    }
    const b = document.getElementById("pos-nav-expenses");
    if (b) b.classList.add("active");
    loadPOSExpenses();
  } else if (viewName === "credits") {
    const el = document.getElementById("pos-credits-view");
    if (el) {
      el.classList.remove("hidden");
      el.style.setProperty("display", "block", "important");
    }
    const b = document.getElementById("pos-nav-credits");
    if (b) b.classList.add("active");
    loadCredits();
  } else if (viewName === "hr") {
    const el = document.getElementById("pos-hr-view");
    if (el) {
      el.classList.remove("hidden");
      el.style.setProperty("display", "block", "important");
    }
    const b = document.getElementById("pos-nav-hr");
    if (b) b.classList.add("active");
    loadEmployees();
  } else if (viewName === "tech") {
    const el = document.getElementById("pos-tech-view");
    if (el) {
      el.classList.remove("hidden");
      el.style.setProperty("display", "block", "important");
    }
    const b = document.getElementById("pos-nav-tech");
    if (b) b.classList.add("active");
    loadTechTenants();
  }
}
window.switchPOSView = switchPOSView;

function switchHRView(viewName) {
  // Hide all HR sub-sections
  document
    .querySelectorAll(".hr-sub-view")
    .forEach((v) => v.classList.add("hidden"));

  // UI Toggle for buttons
  const hrBtns = document.querySelectorAll(".tab-scroller .nav-btn");
  hrBtns.forEach((b) => {
    b.classList.remove("active");
    if (b.getAttribute("id").includes(viewName)) b.classList.add("active");
  });

  if (viewName === "recruitment") {
    document.getElementById("hr-recruitment-view").classList.remove("hidden");
    loadEmployees();
  } else if (viewName === "payroll") {
    document.getElementById("hr-payroll-view").classList.remove("hidden");
    if (!document.getElementById("payroll-month").value) {
      const now = new Date();
      document.getElementById("payroll-month").value =
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    }
    loadPayrollStatus();
  } else if (viewName === "blueprint") {
    document.getElementById("hr-blueprint-view").classList.remove("hidden");
    loadBusinessConfig();
    loadUserAccounts();
    loadRoles();
    // Devices section: only HR and CEO can see company devices
    const devContainer = document.getElementById("connected-devices-container");
    if (["HR", "CEO"].includes(USER_ROLE)) {
      if (devContainer) devContainer.style.display = "";
      loadDevices();
      startDevicesAutoRefresh();
    } else {
      if (devContainer) devContainer.style.display = "none";
    }
  } else if (viewName === "permissions") {
    document.getElementById("hr-permissions-view").classList.remove("hidden");
    loadEmployeePermissions();
  }
}

async function loadEmployeePermissions() {
  const tbody = document.getElementById("emp-permissions-tbody");
  if (!tbody) return;
  tbody.innerHTML =
    '<tr><td colspan="13" style="text-align:center;padding:20px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>';
  try {
    const res = await fetchAuth(`${API_URL}/employees`);
    const data = await res.json();
    const employees = data.employees || [];
    if (employees.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="13" style="text-align:center;color:var(--text-muted);">No employees found.</td></tr>';
      return;
    }
    tbody.innerHTML = "";
    const PERMS = [
      "can_see_dashboard",
      "can_see_hr",
      "can_see_attendance",
      "can_see_sme",
      "can_see_pos",
      "can_see_secretary",
      "can_see_transport",
      "can_see_hardware",
      "can_see_system_users",
      "can_see_schedules",
    ];
    employees.forEach((emp) => {
      const tr = document.createElement("tr");
      const checkboxes = PERMS.map(
        (p) => `
                <td style="text-align:center;">
                    <input type="checkbox" ${emp[p] ? "checked" : ""}
                        onchange="updateEmployeePermission(${emp.id}, '${p}', this.checked, this)"
                        title="${p.replace("can_see_", "").replace("_", " ")}">
                </td>
            `,
      ).join("");
      tr.innerHTML = `
                <td style="font-weight:600;font-size:0.85rem;">${emp.employee_code || emp.id}</td>
                <td>${emp.first_name} ${emp.last_name}</td>
                <td><span style="background:var(--primary);color:#fff;padding:2px 8px;border-radius:20px;font-size:0.75rem;">${emp.role || "-"}</span></td>
                ${checkboxes}
            `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    tbody.innerHTML =
      '<tr><td colspan="13" style="color:red;text-align:center;">Failed to load employees.</td></tr>';
    console.error("loadEmployeePermissions error:", e);
  }
}

async function updateEmployeePermission(empId, permKey, isChecked, checkboxEl) {
  if (checkboxEl) checkboxEl.disabled = true;
  try {
    // Only send the single key that changed — server will update just that column
    const payload = {};
    payload[permKey] = isChecked ? 1 : 0;
    const res = await fetchAuth(`${API_URL}/employees/${empId}/permissions`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Failed");
    showToast(
      `✅ Permission updated. Ask them to re-login to see changes.`,
      "success",
    );
  } catch (e) {
    showToast("Failed to update permission.", "error");
    if (checkboxEl) checkboxEl.checked = !isChecked; // Revert checkbox
    console.error("updateEmployeePermission error:", e);
  } finally {
    if (checkboxEl) checkboxEl.disabled = false;
  }
}

// ==== POS EXPENSES & CASH IN (DRAWER FLOAT) ====
function setPOSCashTab(mode) {
  const expenseForm = document.getElementById("form-pos-expense");
  const cashinForm = document.getElementById("form-pos-cashin");
  const tabExpense = document.getElementById("tab-btn-expense");
  const tabCashin = document.getElementById("tab-btn-cashin");
  const title = document.getElementById("pos-cash-entry-title");

  if (mode === "cashin") {
    if (expenseForm) expenseForm.style.display = "none";
    if (cashinForm) cashinForm.style.display = "flex";
    if (tabExpense) {
      tabExpense.style.background = "transparent";
      tabExpense.style.color = "var(--text-muted)";
    }
    if (tabCashin) {
      tabCashin.style.background = "#10B981";
      tabCashin.style.color = "#fff";
    }
    if (title) title.innerHTML = '<i class="fa-solid fa-hand-holding-dollar" style="color:#10B981;"></i> Add Cash to Drawer';
  } else {
    if (expenseForm) expenseForm.style.display = "flex";
    if (cashinForm) cashinForm.style.display = "none";
    if (tabExpense) {
      tabExpense.style.background = "#EF4444";
      tabExpense.style.color = "#fff";
    }
    if (tabCashin) {
      tabCashin.style.background = "transparent";
      tabCashin.style.color = "var(--text-muted)";
    }
    if (title) title.innerHTML = '<i class="fa-solid fa-money-bill-transfer" style="color:#EF4444;"></i> Record Expense';
  }
}
window.setPOSCashTab = setPOSCashTab;

async function loadPOSExpenses() {
  const tbody = document.getElementById("pos-expenses-tbody");
  if (!tbody) return;
  if (!tbody.children.length || tbody.innerText.includes("Loading")) {
    tbody.innerHTML =
      '<tr><td colspan="4" style="text-align:center; padding:30px; color:#94A3B8;"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>';
  }

  try {
    const res = await fetchAuth(`${API_URL}/transactions?type=EXPENSE,CASH_IN,FLOAT_IN&force_refresh=1&t=${Date.now()}`);
    const data = await res.json();

    function isCashInTx(t) {
      if (!t) return false;
      const type = (t.type || "").toUpperCase();
      if (type === "CASH_IN" || type === "FLOAT_IN") return true;
      const desc = (t.description || "").toLowerCase();
      if (
        (type === "INCOME" || type === "GENERAL" || !type) &&
        (desc.includes("cash in") ||
          desc.includes("cash-in") ||
          desc.includes("float") ||
          desc.includes("drawer") ||
          desc.includes("top up") ||
          desc.includes("top-up") ||
          desc.includes("addition"))
      ) {
        return true;
      }
      return false;
    }

    function isExpenseTx(t) {
      if (!t) return false;
      return (t.type || "").toUpperCase() === "EXPENSE";
    }

    // Filter EXPENSE and CASH_IN / FLOAT transactions (including from Financial Hub)
    const txs = (data.transactions || []).filter(
      (t) => isExpenseTx(t) || isCashInTx(t),
    );

    // Compute totals
    const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
    const todayEAT = new Date(Date.now() + EAT_OFFSET_MS)
      .toISOString()
      .split("T")[0];

    let todayExp = 0,
      todayCashIn = 0,
      allExp = 0;

    txs.forEach((t) => {
      const amt = parseFloat(t.amount) || 0;
      const isCashIn = isCashInTx(t);

      if (!isCashIn) allExp += amt;

      const txDate = new Date(
        String(t.transaction_date).replace(" ", "T") +
          (t.transaction_date.includes("Z") ? "" : "Z"),
      );
      const txDateEAT = new Date(txDate.getTime() + EAT_OFFSET_MS)
        .toISOString()
        .split("T")[0];

      if (txDateEAT === todayEAT) {
        if (isCashIn) {
          todayCashIn += amt;
        } else {
          todayExp += amt;
        }
      }
    });

    // Update summary pills
    const todayExpEl = document.getElementById("pos-exp-today");
    const todayCashinEl = document.getElementById("pos-cashin-today");
    const totalExpEl = document.getElementById("pos-exp-total");
    if (todayExpEl) todayExpEl.textContent = `UGX ${todayExp.toLocaleString()}`;
    if (todayCashinEl) todayCashinEl.textContent = `UGX ${todayCashIn.toLocaleString()}`;
    if (totalExpEl) totalExpEl.textContent = `UGX ${allExp.toLocaleString()}`;

    // Enforce Permission for Expense/Float Entry — CASHIER ONLY
    const _expUserRole = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
    const canRecord = _expUserRole === "CASHIER" || USER_NAME === "System Technician";
    const formExp = document.getElementById("form-pos-expense");
    const formCashin = document.getElementById("form-pos-cashin");
    const tabsContainer = document.getElementById("tab-btn-expense")?.parentElement;
    const entryTitle = document.getElementById("pos-cash-entry-title");
    let notice = document.getElementById("pos-admin-exp-notice");

    if (!canRecord) {
      if (formExp) formExp.style.display = "none";
      if (formCashin) formCashin.style.display = "none";
      if (tabsContainer) tabsContainer.style.display = "none";
      if (entryTitle) {
        entryTitle.innerHTML = '<i class="fa-solid fa-lock" style="color:var(--primary);"></i> Expense & Float (Read-Only)';
      }
      if (!notice) {
        notice = document.createElement("div");
        notice.id = "pos-admin-exp-notice";
        notice.style.cssText = "background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.25); border-radius:10px; padding:14px; font-size:0.85rem; color:var(--text-muted); line-height:1.4; margin-top:10px;";
        notice.innerHTML = '<i class="fa-solid fa-circle-info" style="color:var(--primary); margin-right:6px;"></i> <strong>View Only:</strong> Only the cashier on duty at the till can record drawer expenses or add cash float.';
        const leftCard = document.querySelector("#pos-expenses-view .card");
        if (leftCard) leftCard.appendChild(notice);
      }
    } else {
      if (notice) notice.remove();
      if (tabsContainer) tabsContainer.style.display = "flex";
      const isCashinActive = formCashin && formCashin.style.display === "flex";
      if (!isCashinActive && typeof setPOSCashTab === "function") {
        setPOSCashTab("expense");
      }
    }

    // Populate table
    tbody.innerHTML = "";
    if (txs.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="4" style="text-align:center; padding:40px; color:#94A3B8;">No expenses or cash additions recorded yet.</td></tr>';
      return;
    }

    txs.forEach((t) => {
      const isCashIn = isCashInTx(t);
      const amt = parseFloat(t.amount) || 0;

      let category = "General";
      let desc = t.description || "—";

      if (isCashIn) {
        category = "Cash In";
      } else {
        const parts = (t.description || "").split(" | ");
        category = parts.length > 1 ? parts[0] : "General";
        desc = parts.length > 1 ? parts[1] : t.description || "—";
      }

      const categoryColors = {
        Supplies: "#F59E0B",
        Utilities: "#6366F1",
        Transport: "#10B981",
        Maintenance: "#EC4899",
        "Staff Welfare": "#8B5CF6",
        General: "#94A3B8",
        Other: "#64748B",
      };
      const catColor = isCashIn ? "#10B981" : (categoryColors[category] || "#94A3B8");

      const tr = document.createElement("tr");
      tr.style.borderBottom = "1px solid rgba(255,255,255,0.05)";
      tr.innerHTML = `
        <td style="padding:12px; font-size:0.82rem; color:#94A3B8; white-space:nowrap;">${formatDisplayDate(t.transaction_date, true)}</td>
        <td style="padding:12px;">
          <span style="background:${catColor}22; color:${catColor}; border:1px solid ${catColor}55; padding:3px 9px; border-radius:20px; font-size:0.72rem; font-weight:700; white-space:nowrap;">
            ${isCashIn ? '<i class="fa-solid fa-arrow-down-long"></i> Cash In' : category}
          </span>
        </td>
        <td style="padding:12px; font-size:0.88rem; color:var(--text);">${desc}</td>
        <td style="padding:12px; text-align:right; font-weight:700; color:${isCashIn ? '#10B981' : '#EF4444'}; white-space:nowrap;">
          ${isCashIn ? '+UGX ' : '-UGX '}${amt.toLocaleString()}
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error("Load POS Expenses Error:", e);
    tbody.innerHTML =
      '<tr><td colspan="4" style="text-align:center; padding:30px; color:#EF4444;">Failed to load transactions.</td></tr>';
  }
}

async function handlePOSExpenseSubmit(e) {
  e.preventDefault();
  const btn = e.submitter || e.target.querySelector('[type="submit"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving...";
  }

  const amount = parseFloat(document.getElementById("pos-exp-amount").value);
  const category = document.getElementById("pos-exp-category").value;
  const desc = document.getElementById("pos-exp-desc").value.trim();

  if (!amount || amount <= 0) {
    showToast(`Please enter a valid amount.`, "danger");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Record Expense";
    }
    return;
  }

  try {
    const res = await fetchAuth(`${API_URL}/transactions`, {
      method: "POST",
      body: JSON.stringify({
        amount,
        type: "EXPENSE",
        description: `${category} | ${desc}`,
      }),
    });

    if (res.ok) {
      showToast(
        `Expense of UGX ${amount.toLocaleString()} recorded.`,
        "success",
      );
      if (window.OfflineDB && typeof window.OfflineDB.bustCache === "function") {
        await window.OfflineDB.bustCache("/transactions").catch(() => {});
      }
      loadPOSExpenses();
      if (typeof loadDashboard === "function") loadDashboard();
    } else {
      const data = await res.json();
      showToast(data.error || "Failed to save expense.", "danger");
    }
  } catch (err) {
    console.error("Expense Submit Error:", err);
    showToast("Network error. Please check server.", "danger");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Record Expense";
    }
  }
}

async function handlePOSCashInSubmit(e) {
  e.preventDefault();
  const btn = e.submitter || e.target.querySelector('[type="submit"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Adding Cash...";
  }

  const amount = parseFloat(document.getElementById("pos-cashin-amount")?.value);
  const purpose = document.getElementById("pos-cashin-purpose")?.value || "Cash Drawer Float";
  const auth = document.getElementById("pos-cashin-auth")?.value?.trim() || "Admin";
  const notes = document.getElementById("pos-cashin-notes")?.value?.trim() || "";

  if (!amount || amount <= 0) {
    showToast("Please enter a valid cash amount.", "danger");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "+ Add Cash to Drawer";
    }
    return;
  }

  try {
    const res = await fetchAuth(`${API_URL}/pos/cash-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount,
        purpose,
        authorized_by: auth,
        notes,
      }),
    });

    if (res.ok) {
      showToast(
        `UGX ${amount.toLocaleString()} added to drawer float successfully!`,
        "success",
      );
      e.target.reset();

      // Immediately update Today's Cash In pill optimistically
      const todayCashinEl = document.getElementById("pos-cashin-today");
      if (todayCashinEl) {
        const cur = parseFloat((todayCashinEl.textContent || "0").replace(/[^0-9.]/g, "")) || 0;
        todayCashinEl.textContent = `UGX ${(cur + amount).toLocaleString()}`;
      }

      if (window.OfflineDB && typeof window.OfflineDB.bustCache === "function") {
        await window.OfflineDB.bustCache("/transactions").catch(() => {});
      }
      await loadPOSExpenses();
      if (typeof loadDashboard === "function") loadDashboard();
    } else {
      const data = await res.json();
      showToast(data.error || "Failed to add cash to drawer.", "danger");
    }
  } catch (err) {
    console.error("Cash In Submit Error:", err);
    showToast("Network error. Please check server.", "danger");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "+ Add Cash to Drawer";
    }
  }
}
window.handlePOSCashInSubmit = handlePOSCashInSubmit;

async function saveBusinessConfig() {
  const config = {
    days: Array.from(
      document.querySelectorAll("#config-days input:checked"),
    ).map((i) => i.value),
    hoursPerShift: document.getElementById("config-shift-hours").value,
    openingTime: document.getElementById("config-open-time").value,
    staffing: {},
  };
  document.querySelectorAll(".staff-req").forEach((i) => {
    config.staffing[i.getAttribute("data-role")] = i.value;
  });

  try {
    const res = await fetchAuth(`${API_URL}/settings`, {
      method: "POST",
      body: JSON.stringify({ key: "BUSINESS_BLUEPRINT", data: config }),
    });
    if (res.ok) alert("Master Configuration Saved Successfully!");
    else alert("Failed to save configuration.");
  } catch (e) {
    console.error("Config Save Error:", e);
  }
}

async function loadBusinessConfig() {
  try {
    // First, fetch roles to build the dynamic staffing list
    const rolesRes = await fetchAuth(`${API_URL}/roles`);
    const rolesData = await rolesRes.json();
    const roles = rolesData.roles;

    const staffingContainer = document.getElementById(
      "config-staffing-dynamic",
    );
    if (staffingContainer) {
      staffingContainer.innerHTML = "";
      roles.forEach((r) => {
        const div = document.createElement("div");
        div.className = "form-group";
        div.style =
          "display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;";
        div.innerHTML = `
                    <div style="display:flex; align-items:center; gap:10px;">
                        <button class="sm-btn danger" onclick="deleteRoleBlueprint('${r.role_name}')" title="Delete Role"><i class="fa-solid fa-xmark"></i></button>
                        <label>${r.role_name}</label>
                    </div>
                    <input type="number" class="staff-req" data-role="${r.role_name}" value="0" style="width: 60px; background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 5px; border-radius: 4px;">
                `;
        staffingContainer.appendChild(div);
      });
    }

    // Now fetch actual settings
    const res = await fetchAuth(`${API_URL}/settings`);
    const data = await res.json();
    const config = data.settings ? data.settings["BUSINESS_BLUEPRINT"] : null;
    if (!config) return;

    // Populate days
    document.querySelectorAll("#config-days input").forEach((i) => {
      i.checked = config.days ? config.days.includes(i.value) : false;
    });
    // Populate hours/times
    if (document.getElementById("config-shift-hours"))
      document.getElementById("config-shift-hours").value =
        config.hoursPerShift || 8;
    if (document.getElementById("config-open-time"))
      document.getElementById("config-open-time").value =
        config.openingTime || "08:00";

    // Populate dynamic staffing counts
    document.querySelectorAll(".staff-req").forEach((i) => {
      const role = i.getAttribute("data-role");
      if (config.staffing && config.staffing[role])
        i.value = config.staffing[role];
    });
  } catch (e) {
    console.error("Config Load Error:", e);
  }
}

async function addNewRoleBlueprint() {
  const name = document.getElementById("new-role-name").value.trim();
  if (!name) return alert("Enter a role name");

  try {
    const res = await fetchAuth(`${API_URL}/roles`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      alert("Role added successfully!");
      document.getElementById("new-role-name").value = "";
      loadBusinessConfig();
      loadRoles();
    } else {
      const data = await res.json();
      alert("Fail: " + (data.error || "Invalid request"));
    }
  } catch (e) {
    console.error("Role Add Error:", e);
  }
}

async function deleteRoleBlueprint(roleName) {
  if (
    !confirm(
      `Delete role "${roleName}"? This will affect all staff assigned to this role.`,
    )
  )
    return;
  try {
    const res = await fetchAuth(`${API_URL}/roles/${roleName}`, {
      method: "DELETE",
    });
    if (res.ok) {
      loadBusinessConfig();
      loadRoles();
    }
  } catch (e) {
    console.error("Role Delete Error:", e);
  }
}

// ==== DASHBOARD LOGIC ====
async function loadUpcomingPay() {
  try {
    const res = await fetch(`${API_URL}/employees/upcoming-pay`, {
      headers: {
        Authorization: `Bearer ${localStorage.getItem("jomish_token")}`,
      },
    });
    if (res.ok) {
      const data = await res.json();
      const countEl = document.getElementById("upcoming-pay-count");
      const panel = document.getElementById("upcoming-pay-panel");
      const itemsDiv = document.getElementById("upcoming-pay-items");
      if (countEl) countEl.textContent = data.length;
      if (data.length > 0) {
        if (panel) panel.classList.remove("hidden");
        if (itemsDiv)
          itemsDiv.innerHTML = data
            .map(
              (
                e,
              ) => `<div style="background: white; padding: 10px; border-radius: 8px; border: 1px solid #E5E7EB; flex: 1 1 200px;">
                    <div style="font-weight: bold; color: #111827;">${e.first_name} ${e.last_name}</div>
                    <div style="font-size: 0.8rem; color: #6B7280;">${e.role} - Pay due on ${new Date(e.next_pay_date).toLocaleDateString()}</div>
                </div>`,
            )
            .join("");
      } else {
        if (panel) panel.classList.add("hidden");
      }
    }
  } catch (e) {
    console.error("Upcoming pay error:", e);
  }
}

async function loadDashboard() {
  startLiveClock();
  startRadarAutoRefresh(); // Start 30-second auto-refresh for the hardware radar
  loadDayTimetable();
  loadHardwareRadar();
  loadFinanceIntelligence();
  loadUpcomingPay();
  loadLowStockAlerts();
  loadPresenceSummary();
  loadDeskMessages();
}

async function loadPresenceSummary() {
  try {
    const res = await fetchAuth(`${API_URL}/attendance/summary`);
    const data = await res.json();
    document.getElementById("stat-present-count").innerText = data.present;
    document.getElementById("stat-sick-count").innerText = data.sick;
    document.getElementById("stat-total-count").innerText = data.total;
  } catch (e) {
    console.error("Presence intelligence failure", e);
  }
}

// ==== HARDWARE RADAR LOGIC ====
// Robustly parse a SQLite datetime string (with or without T/Z) into a JS Date.
function safeParseDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  // Already valid ISO with Z or +offset — parse directly
  if (/Z$|[+-]\d{2}:\d{2}$/.test(s)) return new Date(s);
  // SQLite format: "YYYY-MM-DD HH:MM:SS" — treat as UTC
  const normalized = s.replace(" ", "T") + "Z";
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? new Date(s) : d;
}
function registerDevice() {
  let devId = localStorage.getItem("jomish_device_id");
  if (!devId) {
    devId =
      "JOM-DEV-" + Math.random().toString(36).substring(2, 9).toUpperCase();
    localStorage.setItem("jomish_device_id", devId);
  }

  const devName =
    navigator.platform + " (" + (navigator.vendor || "Generic") + ")";
  const devType = /Mobile|Android|iPhone/i.test(navigator.userAgent)
    ? "MOBILE"
    : "TERMINAL";

  // Initial Ping
  pingDevice(devId, devName, devType);

  // Continuous Heartbeat (every 30s)
  setInterval(() => pingDevice(devId, devName, devType), 30000);
}

// ==== DEVICE MANAGEMENT ====
async function loadDevices() {
  const tbody = document.querySelector("#connected-devices-table tbody");
  if (!tbody) return;
  tbody.innerHTML =
    '<tr><td colspan="6" style="text-align:center; padding:20px; color:#94A3B8;">Loading devices...</td></tr>';

  try {
    const res = await fetchAuth(`${API_URL}/devices`);
    const data = await res.json();
    tbody.innerHTML = "";

    if (!data.devices || data.devices.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center; padding:20px; color:#94A3B8;">No devices connected.</td></tr>';
      return;
    }

    data.devices.forEach((d) => {
      const lastSeen = safeParseDate(d.last_seen);
      const isOnline = lastSeen && new Date() - lastSeen < 120000;
      const lastSeenStr = lastSeen
        ? lastSeen.toLocaleString("en-UG", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })
        : "Never";
      const statusBadge = isOnline
        ? '<span style="background:var(--success);color:white;padding:3px 8px;border-radius:12px;font-size:0.75rem;">&#x25CF; ONLINE</span>'
        : '<span style="background:var(--danger);color:white;padding:3px 8px;border-radius:12px;font-size:0.75rem;">&#x25CF; OFFLINE</span>';

      const myDevId = localStorage.getItem("jomish_device_id");
      const isMe =
        d.device_id === myDevId
          ? ' <b style="color:var(--primary);">(This Device)</b>'
          : "";

      const tr = document.createElement("tr");
      tr.innerHTML = `
                <td>${d.device_name}${isMe}</td>
                <td>${d.device_type}</td>
                <td style="font-family:monospace;">${d.ip_address || "—"}</td>
                <td>${statusBadge}</td>
                <td>${lastSeenStr}</td>
                <td>
                    <button class='sm-btn danger' onclick="kickDevice('${d.device_id}')"><i class="fa-solid fa-right-from-bracket"></i> Force Logout</button>
                </td>
            `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error("Failed to load devices:", e);
    tbody.innerHTML =
      '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--danger);">Error loading devices</td></tr>';
  }
}

async function kickDevice(deviceId) {
  if (!confirm("Force this device to log out and disconnect?")) return;

  try {
    const res = await fetchAuth(`${API_URL}/devices/logout`, {
      method: "POST",
      body: JSON.stringify({ device_id: deviceId }),
    });
    if (res.ok) {
      showToast("Device logged out.", "success");
      loadDevices();
    } else {
      showToast("Failed to log out device.", "danger");
    }
  } catch (e) {
    console.error("Kick device error:", e);
  }
}

async function loadFinanceIntelligence() {
  const panel = document.querySelector(".finance-intel");
  // Only CEO and HR can see Financial Intelligence
  if (!["CEO", "HR"].includes(USER_ROLE)) {
    if (panel) panel.style.display = "none";
    return;
  }
  if (panel) panel.style.display = "block";

  try {
    const res = await fetchAuth(`${API_URL}/finance/summary?t=${Date.now()}`);
    const data = await res.json();

    const updateCard = (prefix, values) => {
      const incomeEl = document.getElementById(`fi-${prefix}-income`);
      const expenseEl = document.getElementById(`fi-${prefix}-expense`);
      const profitEl = document.getElementById(`fi-${prefix}-profit`);

      if (incomeEl)
        incomeEl.innerText = `UGX ${(values.income || 0).toLocaleString()}`;
      if (expenseEl)
        expenseEl.innerText = `UGX ${(values.expense || 0).toLocaleString()}`;
      if (profitEl) {
        profitEl.innerText = `UGX ${(values.profit || 0).toLocaleString()}`;
        profitEl.style.color =
          (values.profit || 0) >= 0 ? "#10B981" : "#EF4444";
      }
    };

    updateCard("today", data.today);
    updateCard("week", data.week);
    updateCard("month", data.month);
    updateCard("total", data.allTime);

    // Show the "as of" timestamp so the user knows data is current
    const asOfEl = document.getElementById("fi-as-of");
    if (asOfEl && data.asOf) asOfEl.innerText = `Updated: ${data.asOf}`;

    if (data._debug) {
    }
  } catch (e) {
    console.error("Finance Intel Error:", e);
  }
}

async function loadLowStockAlerts() {
  try {
    const res = await fetchAuth(`${API_URL}/alerts/low-stock`);
    const data = await res.json();
    const panel = document.getElementById("low-stock-panel");
    const count = document.getElementById("low-stock-count");
    const list = document.getElementById("low-stock-items");

    if (!data.alerts || data.alerts.length === 0) {
      panel.classList.add("hidden");
      return;
    }

    panel.classList.remove("hidden");
    count.innerText = data.alerts.length;
    list.innerHTML = "";

    data.alerts.forEach((p) => {
      const badge = document.createElement("div");
      badge.style =
        "background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); padding: 5px 12px; border-radius: 6px; font-size: 0.8rem; display: flex; align-items: center; gap: 8px;";
      badge.innerHTML = `
                <span style="font-weight: bold; color: #EF4444;">${p.name}</span>
                <span style="color: #94A3B8;">Qty: ${p.stock}</span>
                <button class="sm-btn primary" onclick="const q=parseInt(prompt('How many units to add for ${p.name.replace(/'/g, "\\'")}?','10')); if(q>0) restockProduct(${p.id}, q);" style="padding: 2px 8px; font-size: 0.7rem;">Restock</button>
            `;
      list.appendChild(badge);
    });
  } catch (e) {
    console.error("Alerts Error:", e);
  }
}

// Try to get local LAN IP via WebRTC (best effort, may be blocked in some browsers)
async function getLocalIP() {
  return new Promise((resolve) => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel("");
      pc.createOffer().then((offer) => pc.setLocalDescription(offer));
      const timer = setTimeout(() => {
        pc.close();
        resolve(null);
      }, 2000);
      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        const match = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(e.candidate.candidate);
        if (match && !match[1].startsWith("169.254")) {
          clearTimeout(timer);
          pc.close();
          resolve(match[1]);
        }
      };
    } catch {
      resolve(null);
    }
  });
}

async function pingDevice(device_id, device_name, device_type) {
  try {
    const prefix = localStorage.getItem("jomish_prefix");
    const company_schema = prefix ? "t_" + prefix.toLowerCase() : "public";
    const client_ip = await getLocalIP();
    await fetch(`${API_URL}/devices/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id,
        device_name,
        device_type,
        company_schema,
        client_ip,
      }),
    });
  } catch (e) {
    console.error("Radar Ping Error:", e);
  }
}

let _radarInterval = null;
async function loadHardwareRadar() {
  const tbody = document.querySelector("#dash-devices tbody");
  if (!tbody) return;

  try {
    const res = await fetchAuth(`${API_URL}/devices`);
    const data = await res.json();
    tbody.innerHTML = "";

    if (!data.devices || data.devices.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="5" style="text-align:center; padding:20px;">No hardware detected yet.</td></tr>';
      return;
    }

    data.devices.forEach((d) => {
      const lastActive = safeParseDate(d.last_seen);
      const isOnline = lastActive && new Date() - lastActive < 120000;
      const lastActiveStr = lastActive
        ? lastActive.toLocaleString("en-UG", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })
        : "Never";

      const tr = document.createElement("tr");
      tr.innerHTML = `
                <td><code style="background:var(--background); padding:4px 8px; border-radius:4px;">${d.device_id}</code></td>
                <td><strong>${d.device_name}</strong> <br><small style="color:#94A3B8;">${d.device_type}</small></td>
                <td>${d.ip_address || "—"}</td>
                <td>
                    <span class="badge" style="background:${isOnline ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)"}; color:${isOnline ? "var(--success)" : "var(--danger)"};">
                        ${isOnline ? "&#x25CF; ONLINE" : "&#x25CF; OFFLINE"}
                    </span>
                </td>
                <td>${lastActiveStr}</td>
            `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error("Radar Fetch Error:", e);
  }
}

// Start 30-second auto-refresh for the dashboard radar AND HR Blueprint devices table.
// Guarded against stacking — safe to call from loadDashboard() on every tab switch.
let _devicesInterval = null;
function startRadarAutoRefresh() {
  // Polling removed — now driven purely by Socket.io 'db_updated' push events
}

function startDevicesAutoRefresh() {
  // Polling removed — now driven purely by Socket.io 'db_updated' push events
}

let _liveclockInterval = null;
function startLiveClock() {
  if (window._liveclockInterval) return; // Prevent stacking intervals
  window._liveclockInterval = setInterval(() => {
    const now = new Date().toLocaleTimeString("en-US", { hour12: false });
    const clock1 = document.getElementById("live-clock");
    const clock2 = document.getElementById("live-clock-dash");
    if (clock1) clock1.textContent = now;
    if (clock2) clock2.textContent = now;
  }, 1000);
}

// loadNotices, toggleNoticeEdit, and saveNotice have been removed and replaced by the Command Notice Board system.

// loadDayTimetable is now handled by the Smart Shift Timetable IIFE at the bottom of this file.
// It is exposed on window and called from initDashboard.

function initSockets() {
  if (typeof io === "undefined") {
    console.warn("Socket.io not loaded. Live sync will be disabled.");
    const statusEl = document.getElementById("live-sync-indicator");
    if (statusEl) {
      statusEl.style.color = "var(--danger)";
      statusEl.innerHTML =
        '<i class="fa-solid fa-circle" style="color: #EF4444;"></i> Offline Mode (No Sync)';
    }
    return;
  }
  // Dynamic connection: automatically use current host/port
  const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
  });
  window._socket = socket; // Expose for sub-modules (Smart Timetable IIFE)

  socket.on("connect", () => {
    const statusEl = document.getElementById("live-sync-indicator");
    if (statusEl) {
      statusEl.style.color = "var(--success)";
      statusEl.innerHTML =
        '<i class="fa-solid fa-circle" style="color: #10B981;"></i> Live Sync Active';
    }
  });

  socket.on("disconnect", () => {
    const statusEl = document.getElementById("live-sync-indicator");
    if (statusEl) {
      statusEl.style.color = "var(--danger)";
      statusEl.innerHTML =
        '<i class="fa-solid fa-circle" style="color: #EF4444;"></i> Disconnected';
    }
  });

  socket.on("db_updated", (data) => {
    if (data.module === "employees") {
      if (USER_PERMISSIONS.can_see_hr) loadEmployees();
      if (typeof loadUserAccounts === "function") loadUserAccounts();
      if (typeof loadSystemUsers === "function") loadSystemUsers();
    } else if (data.module === "attendance") {
      if (USER_PERMISSIONS.can_see_attendance) {
        loadAttendance();
        loadDashboard();
      }
    } else if (data.module === "transactions") {
      if (window.OfflineDB && typeof window.OfflineDB.bustCache === "function") {
        window.OfflineDB.bustCache("/transactions").catch(() => {});
        window.OfflineDB.bustCache("/deliveries").catch(() => {});
        window.OfflineDB.bustCache("/customer-invoices").catch(() => {});
        window.OfflineDB.bustCache("/pos_orders").catch(() => {});
      }
      if (USER_PERMISSIONS.can_see_sme || document.querySelector("#transactions-table")) {
        loadTransactions();
        loadDashboard();
      }
      const expView = document.getElementById("pos-expenses-view");
      if (expView && !expView.classList.contains("hidden")) {
        loadPOSExpenses();
      }
      if (data.pos_order_id || data.transaction_id || data.pos_order_ids) {
        if (typeof removePendingOrderFromUI === "function") {
          const ids = data.pos_order_ids || (data.pos_order_id ? [data.pos_order_id] : []);
          ids.forEach(pId => removePendingOrderFromUI(pId, data.transaction_id));
          if (!ids.length && data.transaction_id) removePendingOrderFromUI(null, data.transaction_id);
        }
      }
      if (typeof loadPendingCOD === "function") loadPendingCOD(true);
      if (typeof loadCustomerInvoices === "function") loadCustomerInvoices();
    } else if (
      data.module === "schedules" ||
      data.module === "shift_assignments"
    ) {
      // Refresh dashboard timetable always; full grid only if tab is active
      if (typeof window.loadDayTimetable === "function")
        window.loadDayTimetable();
      const section = document.getElementById("schedules");
      if (
        section &&
        section.classList.contains("active") &&
        typeof window.loadShiftTimetable === "function"
      ) {
        window.loadShiftTimetable();
      }
    } else if (data.module === "shifts") {
      if (typeof updateCashierShiftUI === "function") updateCashierShiftUI();
    } else if (data.module === "deliveries" || data.module === "pos") {
      if (window.OfflineDB && typeof window.OfflineDB.bustCache === "function") {
        window.OfflineDB.bustCache("/deliveries").catch(() => {});
        window.OfflineDB.bustCache("/customer-invoices").catch(() => {});
        window.OfflineDB.bustCache("/pos_orders").catch(() => {});
      }
      if (data.pos_order_id || data.transaction_id || data.pos_order_ids) {
        if (typeof removePendingOrderFromUI === "function") {
          const ids = data.pos_order_ids || (data.pos_order_id ? [data.pos_order_id] : []);
          ids.forEach(pId => removePendingOrderFromUI(pId, data.transaction_id));
          if (!ids.length && data.transaction_id) removePendingOrderFromUI(null, data.transaction_id);
        }
      }
      if (typeof loadDeliveries === "function") loadDeliveries();
      if (typeof loadPendingCOD === "function") loadPendingCOD(true);
      if (typeof loadCustomerInvoices === "function") loadCustomerInvoices();
    } else if (data.module === "products") {
      cachedProducts = []; // Bust cache so next POS scan fetches fresh data with additional_barcodes
      if (window.OfflineDB && typeof window.OfflineDB.bustCache === "function") {
        window.OfflineDB.bustCache("/api/products").catch(() => {});
        window.OfflineDB.bustCache("/reports/products-sold").catch(() => {});
        window.OfflineDB.bustCache("/api/reports/products-sold").catch(() => {});
      }
      if (USER_PERMISSIONS.can_see_pos && !window._skipProductReload)
        loadPOSProducts();
      const smeProdView = document.getElementById("sme-view-products");
      if (smeProdView && smeProdView.style.display !== "none" && typeof loadSmeProductSales === "function") {
        loadSmeProductSales();
      }
      const invSection = document.getElementById("inventory");
      if (invSection && invSection.classList.contains("active") && typeof loadInventory === "function") {
        loadInventory();
      }
      const pModal = document.getElementById("product-sales-counter-modal");
      if (pModal && !pModal.classList.contains("hidden") && typeof fetchAndRenderProductSalesModal === "function") {
        fetchAndRenderProductSalesModal();
      }
    } else if (data.module === "logo" || data.module === "settings") {
      loadBrandLogo();
      loadBusinessConfig();
    } else if (data.module === "roles") {
      loadRoles();
      loadBusinessConfig();
    } else if (data.module === "messages") {
      loadDeskMessages();
    } else if (data.module === "calendar") {
      if (typeof renderCalendar === "function") renderCalendar();
    } else if (data.module === "emails") {
      if (USER_PERMISSIONS.can_see_secretary) {
        if (typeof fetchGlobalUnreadEmails === "function")
          fetchGlobalUnreadEmails();
        loadEmails();
      }
    } else if (data.module === "devices") {
      // Refresh dashboard radar
      loadHardwareRadar();
      // Refresh HR Blueprint devices table if it's present in the DOM
      const devTable = document.querySelector("#connected-devices-table tbody");
    } else if (data.module === "credits") {
      if (window.OfflineDB && typeof window.OfflineDB.bustCache === "function") {
        window.OfflineDB.bustCache("/credits").catch(() => {});
        window.OfflineDB.bustCache("/api/credits").catch(() => {});
      }
      if (typeof loadCredits === "function") {
        loadCredits();
      }
    }
  });

  // Real-time order deleted notification
  socket.on("order_deleted", (data) => {
    if (!data) return;
    if (typeof removePendingOrderFromUI === "function") {
      const ids = data.pos_order_ids || (data.pos_order_id ? [data.pos_order_id] : []);
      ids.forEach(pId => removePendingOrderFromUI(pId, data.transaction_id));
      if (!ids.length && data.transaction_id) removePendingOrderFromUI(null, data.transaction_id);
    }
    if (window.OfflineDB && typeof window.OfflineDB.bustCache === "function") {
      window.OfflineDB.bustCache("/deliveries").catch(() => {});
      window.OfflineDB.bustCache("/customer-invoices").catch(() => {});
      window.OfflineDB.bustCache("/pos_orders").catch(() => {});
      window.OfflineDB.bustCache("/transactions").catch(() => {});
    }
    if (typeof loadPendingCOD === "function") loadPendingCOD(true);
    if (typeof loadCustomerInvoices === "function") loadCustomerInvoices();
  });

  // Real-time message notification
  socket.on("new_message", (data) => {
    const myId = parseInt(localStorage.getItem("jomish_user_id"));
    if (data.to_id === myId) {
      showToast(`New message from ${data.from}`, "info");
      loadDeskMessages();
    }
  });

  socket.on("force_logout", (data) => {
    const myDevId = localStorage.getItem("jomish_device_id");
    if (data.device_id === myDevId) {
      alert("Your session has been terminated by the administrator.");
      localStorage.clear();
      window.location.href = "login.html";
    }
  });
}

// Force explicit camera permission prompt before starting
async function requestCameraPermission() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert(
      "Camera Access Disabled!\n\nYour browser blocked camera access because this is not a secure (HTTPS) connection.\n\nTo fix on Android/Chrome: Go to chrome://flags, search for 'insecure origins treated as secure', and add this URL.",
    );
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    // Stop stream immediately so the scanner library can take over
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch (err) {
    alert("Camera Permission Denied or Unavailable:\n\n" + err.message);
    return false;
  }
}

async function stopScanner() {
  if (html5QrcodeScanner && isScannerRunning) {
    try {
      await html5QrcodeScanner.stop();
      isScannerRunning = false;
    } catch (e) {
      console.error("Stop error", e);
      // Forced reset if stop fails
      isScannerRunning = false;
    }
  }
}

async function handleAutomatedScan(id) {
  if (!id) return;

  // Visual feedback for successful scan
  const resultsEl = document.getElementById("qr-reader-results");
  resultsEl.innerHTML =
    `<i class="fa-solid fa-magnifying-glass"></i> Processing Code: ` + id;
  resultsEl.style.color = "var(--primary)";

  // Haptic feedback if supported
  if (navigator.vibrate) navigator.vibrate(100);

  try {
    const res = await fetchAuth(`${API_URL}/attendance/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: id, scan_type: "AUTO" }),
    });
    const data = await res.json();
    if (res.ok) {
      resultsEl.innerHTML =
        `<i class="fa-solid fa-check"></i> Logged: ` + (data.name || id);
      resultsEl.style.color = "var(--success)";
      loadAttendance();

      // Temporary highlight effect
      const reader = document.getElementById("qr-reader");
      reader.style.borderColor = "var(--success)";
      setTimeout(() => (reader.style.borderColor = "var(--primary)"), 1000);
    } else {
      resultsEl.innerHTML =
        `<i class="fa-solid fa-xmark"></i> ` + (data.error || "Failed");
      resultsEl.style.color = "var(--danger)";
    }
  } catch (e) {
    console.error("Auto scan error:", e);
    resultsEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Network Error`;
    resultsEl.style.color = "var(--danger)";
  }
}

// ==== POS CART STATE ====
let posCart = [];
window.posCart = posCart;
const TAX_RATE = 0.0;

function enforceRBAC() {
  const navDashboard = document.querySelector('[data-target="dashboard"]');
  const navHR = document.querySelector('[data-target="hr-mgmt"]');
  const navQR = document.querySelector('[data-target="attendance"]');
  const navSchedules = document.querySelector('[data-target="schedules"]');
  const navSME = document.querySelector('[data-target="sme-business"]');
  const navPOS = document.querySelector('[data-target="pos-terminal"]');
  const navTransport = document.querySelector('[data-target="transport-hub"]');
  const navSecretary = document.querySelector('[data-target="secretary-hub"]');
  const navTechHub = document.querySelector('[data-target="tech-hub"]');

  // Only the global TECH login (prefix = 'public') gets Tech Hub access — not company-level users
  const _storedPrefix = (localStorage.getItem("jomish_prefix") || "").toLowerCase();
  const isTech =
    (USER_ROLE || "").toUpperCase() === "TECH" && (!_storedPrefix || _storedPrefix === "public");
  const isDemo = localStorage.getItem("jomish_demo") === "true";

  // ── ROLE-BASED ACCESS CONTROL ─────────────────────────────────────────────
  // uRole must be declared before ROLE_TAB_MAP so _roleKey can reference it
  const uRole = (USER_ROLE || "").toUpperCase();

  // pos:true = role can see "POS Terminal" sidebar tab
  // POS sub-tab visibility controlled separately by posNavMap
  const ROLE_TAB_MAP = {
    HR: {
      dashboard: true,
      hr: true,
      qr: true,
      schedules: true,
      sme: true,
      pos: true,
      transport: false,
      secretary: false,
      tech: false,
    },
    Supervisor: {
      dashboard: false,
      hr: false,
      qr: true,
      schedules: true,
      sme: false,
      pos: true,
      transport: false,
      secretary: false,
      tech: false,
    },
    CEO: {
      dashboard: true,
      hr: true,
      qr: false,
      schedules: true,
      sme: true,
      pos: true,
      transport: true,
      secretary: false,
      tech: false,
    },
    Cashier: {
      dashboard: false,
      hr: false,
      qr: false,
      schedules: false,
      sme: false,
      pos: true,
      transport: false,
      secretary: false,
      tech: false,
    },
    Waiter: {
      dashboard: false,
      hr: false,
      qr: false,
      schedules: false,
      sme: false,
      pos: true,
      transport: false,
      secretary: false,
      tech: false,
    },
    Transport: {
      dashboard: false,
      hr: false,
      qr: false,
      schedules: false,
      sme: false,
      pos: false,
      transport: true,
      secretary: false,
      tech: false,
    },
    Secretary: {
      dashboard: false,
      hr: false,
      qr: false,
      schedules: false,
      sme: false,
      pos: false,
      transport: false,
      secretary: true,
      tech: false,
    },
    Receptionist: {
      dashboard: false,
      hr: false,
      qr: true,
      schedules: false,
      sme: false,
      pos: false,
      transport: false,
      secretary: true,
      tech: false,
    },
    Security: {
      dashboard: false,
      hr: false,
      qr: true,
      schedules: false,
      sme: false,
      pos: false,
      transport: false,
      secretary: false,
      tech: false,
    },
    Admin: {
      dashboard: true,
      hr: true,
      qr: false,
      schedules: true,
      sme: true,
      pos: true,
      transport: false,
      secretary: false,
      tech: false,
    },
    Manager: {
      dashboard: true,
      hr: false,
      qr: false,
      schedules: true,
      sme: true,
      pos: true,
      transport: false,
      secretary: false,
      tech: false,
    },
    "Finance Manager": {
      dashboard: true,
      hr: false,
      qr: false,
      schedules: false,
      sme: true,
      pos: true,
      transport: false,
      secretary: false,
      tech: false,
    },
  };

  // Case-insensitive lookup so "CASHIER", "cashier", "Cashier" all resolve
  const _roleKey = Object.keys(ROLE_TAB_MAP).find(
    (k) => k.toUpperCase() === uRole
  ) || USER_ROLE;


  if (isTech || isDemo) {
    // System Technician and Demo mode sees all tabs
    [
      navDashboard,
      navHR,
      navQR,
      navSchedules,
      navSME,
      navPOS,
      navTransport,
      navSecretary,
    ].forEach((n) => {
      if (n) n.style.display = "block";
    });
    if (navTechHub) navTechHub.style.display = "block";
    if (isDemo) {
      document
        .querySelectorAll(".tech-only")
        .forEach((el) => el.classList.add("hidden"));
    } else {
      document
        .querySelectorAll(".tech-only")
        .forEach((el) => el.classList.remove("hidden"));
    }
    document
      .querySelectorAll(".admin-only")
      .forEach((el) => el.classList.remove("hidden"));
  } else if (ROLE_TAB_MAP[_roleKey]) {
    // ── Use ROLE_TAB_MAP as primary source, override with DB permissions if meaningfully set ──
    const p = USER_PERMISSIONS;
    // Only use DB permissions if they have any non-attendance, non-zero value
    // (attendance=1 alone is the default seeded value, not a meaningful override)
    const hasRealPerms = (
      p.can_see_dashboard || p.can_see_hr || p.can_see_sme ||
      p.can_see_pos || p.can_see_secretary || p.can_see_transport
    );
    const roleDefaults = ROLE_TAB_MAP[_roleKey];
    const perms = hasRealPerms
      ? {
          dashboard: p.can_see_dashboard,
          hr: p.can_see_hr,
          qr: p.can_see_attendance,
          schedules: p.can_see_schedules,
          sme: p.can_see_sme,
          pos: p.can_see_pos,
          transport: p.can_see_transport,
          secretary: p.can_see_secretary,
        }
      : roleDefaults; // fallback to hardcoded map when DB has only defaults

    if (navDashboard)
      navDashboard.style.display = perms.dashboard ? "block" : "none";
    if (navHR) navHR.style.display = perms.hr ? "block" : "none";
    if (navQR) navQR.style.display = perms.qr ? "block" : "none";
    if (navSchedules)
      navSchedules.style.display = perms.schedules ? "block" : "none";
    if (navSME) navSME.style.display = perms.sme ? "block" : "none";
    if (navPOS) navPOS.style.display = perms.pos ? "block" : "none";
    if (navTransport)
      navTransport.style.display = perms.transport ? "block" : "none";
    if (navSecretary)
      navSecretary.style.display = perms.secretary ? "block" : "none";
    if (navTechHub) navTechHub.style.display = "none";
    document
      .querySelectorAll(".tech-only")
      .forEach((el) => el.classList.add("hidden"));
    // Admin UI elements (add employee button, role matrix) — HR, CEO, Manager can see these
    if (["HR", "CEO", "MANAGER", "ADMIN"].includes(uRole)) {
      document
        .querySelectorAll(".admin-only")
        .forEach((el) => el.classList.remove("hidden"));
    } else {
      document
        .querySelectorAll(".admin-only")
        .forEach((el) => el.classList.add("hidden"));
    }
  } else {
    // Unknown/fallback role — use USER_PERMISSIONS if available, else show only attendance
    const p = USER_PERMISSIONS;
    if (navDashboard)
      navDashboard.style.display = p.can_see_dashboard ? "block" : "none";
    if (navHR) navHR.style.display = p.can_see_hr ? "block" : "none";
    if (navQR) navQR.style.display = p.can_see_attendance ? "block" : "none";
    if (navSchedules)
      navSchedules.style.display = p.can_see_schedules ? "block" : "none";
    if (navSME) navSME.style.display = p.can_see_sme ? "block" : "none";
    if (navPOS) navPOS.style.display = p.can_see_pos ? "block" : "none";
    if (navTransport)
      navTransport.style.display = p.can_see_transport ? "block" : "none";
    if (navSecretary)
      navSecretary.style.display = p.can_see_secretary ? "block" : "none";
    if (navTechHub) navTechHub.style.display = "none";
    document
      .querySelectorAll(".tech-only")
      .forEach((el) => el.classList.add("hidden"));
    document
      .querySelectorAll(".admin-only")
      .forEach((el) => el.classList.add("hidden"));
  }

  // Demo Mode override — always hide Tech Hub
  // (Handled above in the isTech || isDemo block)

  // Hide admin UI for non-HR/CEO/Manager roles
  if (!["HR", "CEO", "MANAGER", "ADMIN"].includes(uRole) && !isTech) {
    const roleMatrix = document.getElementById("role-matrix-container");
    const brandMatrix = document.getElementById("brand-settings-container");
    if (roleMatrix) roleMatrix.style.display = "none";
    if (brandMatrix) brandMatrix.style.display = "none";
    const btnAddEmp = document.getElementById("btn-add-employee");
    if (btnAddEmp) btnAddEmp.style.display = "none";
  }

  // Toggle Technician Control Panel
  const techPanel = document.getElementById("technician-panel");
  if (techPanel) {
    if (isTech) techPanel.classList.remove("hidden");
    else techPanel.classList.add("hidden");
  }

  // Auto-navigate to first visible tab if current tab is now hidden
  const firstVisible = [
    navDashboard,
    navHR,
    navQR,
    navSchedules,
    navSME,
    navPOS,
    navTransport,
    navSecretary,
    navTechHub,
  ].find((btn) => btn && btn.style.display !== "none");
  const activeSection = document.querySelector(".view-section.active");
  if (activeSection && firstVisible) {
    const activeId = activeSection.id;
    const activeBtn = document.querySelector(
      '[data-target="' + activeId + '"]',
    );
    if (!activeBtn || activeBtn.style.display === "none") {
      firstVisible.click();
    }
  } else if (firstVisible && !activeSection) {
    firstVisible.click();
  }

  // ── POS NAV TAB VISIBILITY BY ROLE ───────────────────────────────────
  // ── POS NAV TAB MATRIX (exact per user spec) ─────────────────────────────
  // CEO / Admin / Manager  : Inventory, Expenses, Credits, Finance Hub, Staff/HR
  // Supervisor / HR        : Expenses, Finance Hub
  // ── POS NAV TAB MATRIX ────────────────────────────────────────────────
  // CEO / Admin / Manager  : Inventory, Expenses, Credits, Finance Hub, Staff/HR
  // Supervisor / HR        : Expenses, Finance Hub
  // Cashier                : Register, Expenses, Credits, Finance Hub
  // Tech (global)          : ALL tabs

  // uRole already computed above — reuse it here
  const role        = uRole;
  const isAdminLike = ["CEO", "ADMIN", "MANAGER", "FINANCE MANAGER", "SUPERVISOR"].includes(role);
  const isHRRole    = role === "HR";
  const isSupervisor = role === "SUPERVISOR";
  const isCashier   = role === "CASHIER";
  const isFinanceMgr = role === "FINANCE MANAGER";

  const isWaiter    = role === "WAITER";

  const posNavMap = {
    // Register — Cashier + Tech + Waiter + Supervisor (Admin does NOT have register)
    "pos-nav-register": isCashier || isTech || isWaiter || isSupervisor,
    // Pending Sales — Cashier + Waiter + Supervisor + Tech + Admin-like
    "pos-nav-pending":  isCashier || isWaiter || isSupervisor || isTech || isAdminLike,
    // Inventory — Admin-like + Tech
    "pos-nav-stock":    isAdminLike || isTech,
    // Low Stock — Admin-like + Tech
    "pos-nav-lowstock": isAdminLike || isTech,
    // Expenses & Cash-In — CASHIER ONLY
    "pos-nav-expenses": isCashier,
    // Credits — Admin-like + Tech
    "pos-nav-credits":  isAdminLike || isTech,
    // Finance Hub — Admin-like + HR + Supervisor + Cashier + Tech
    "pos-nav-finance":  isAdminLike || isHRRole || isSupervisor || isCashier || isTech,
    // Staff / HR — Admin-like (excluding Supervisor) + Tech
    "pos-nav-hr":       (isAdminLike && !isSupervisor) || isTech,
    // Tech sub-tab — Tech ONLY
    "pos-nav-tech":     isTech,
  };

  // ── DEBUG: log role + tab visibility to console ──────────────────────
  console.log(`[RBAC] uRole="${uRole}" isCashier=${isCashier} isTech=${isTech} isAdminLike=${isAdminLike}`);
  console.log(`[RBAC] posNavMap:`, JSON.stringify(posNavMap));

  Object.entries(posNavMap).forEach(([id, visible]) => {
    const btn = document.getElementById(id);
    if (btn) {
      if (visible) {
        btn.style.setProperty("display", id === "pos-nav-tech" ? "flex" : "inline-flex", "important");
        btn.classList.remove("hidden");
      } else {
        btn.style.setProperty("display", "none", "important");
        btn.classList.add("hidden");
      }
    }
  });

  // Sync POS cart buttons according to role
  // Supervisor is at waiter level for register: cannot pay, only prints invoice
  const btnCheckout = document.getElementById("btn-checkout");
  const btnSendToCashier = document.getElementById("btn-send-to-cashier");
  const btnPrintInvoice = document.getElementById("btn-print-invoice") || document.getElementById("btn-waiter-invoice");
  const btnEndShift = document.getElementById("btn-end-shift");

  const isWaiterLevel = isWaiter || isSupervisor; // Supervisor: make order only, no payment
  const shiftControls = document.getElementById("pos-shift-controls");
  if (isWaiterLevel) {
    if (btnCheckout) btnCheckout.style.setProperty("display", "none", "important");
    if (btnSendToCashier) {
      btnSendToCashier.style.setProperty("display", "block", "important");
      btnSendToCashier.innerHTML = '<i class="fa-solid fa-paper-plane"></i> SEND TO CASHIER';
    }
    if (btnPrintInvoice) btnPrintInvoice.style.setProperty("display", "none", "important");
    if (shiftControls) shiftControls.style.setProperty("display", "none", "important");
    if (btnEndShift) btnEndShift.style.setProperty("display", "none", "important");
    const btnStartShift = document.getElementById("btn-start-shift");
    if (btnStartShift) btnStartShift.style.setProperty("display", "none", "important");
  } else if (isCashier) {
    if (btnCheckout) btnCheckout.style.setProperty("display", "block", "important");
    if (btnSendToCashier) btnSendToCashier.style.setProperty("display", "none", "important");
    if (btnPrintInvoice) btnPrintInvoice.style.setProperty("display", "block", "important");
    if (shiftControls) shiftControls.style.setProperty("display", "flex", "important");
    if (typeof updateCashierShiftUI === "function") updateCashierShiftUI();
  } else {
    // Admin/CEO/Manager/Tech etc. — invoice only, no direct payment, no cashier shifts
    if (btnCheckout) btnCheckout.style.setProperty("display", "none", "important");
    if (btnSendToCashier) btnSendToCashier.style.setProperty("display", "none", "important");
    if (btnPrintInvoice) btnPrintInvoice.style.setProperty("display", "block", "important");
    if (shiftControls) shiftControls.style.setProperty("display", "none", "important");
    if (btnEndShift) btnEndShift.style.setProperty("display", "none", "important");
    const btnStartShift = document.getElementById("btn-start-shift");
    if (btnStartShift) btnStartShift.style.setProperty("display", "none", "important");
  }


  // Show/Hide buying price inputs (Admin/CEO/Manager/HR only)
  const canSeeAdminStuff = isAdminLike || isHRRole;
  const addBuyingPriceGroup = document.getElementById("prod-buying-price")?.parentElement;
  if (addBuyingPriceGroup) addBuyingPriceGroup.style.display = canSeeAdminStuff ? "block" : "none";
  const editBuyingPriceGroup = document.getElementById("edit-prod-buying-price")?.parentElement;
  if (editBuyingPriceGroup) editBuyingPriceGroup.style.display = canSeeAdminStuff ? "block" : "none";

  // Auto-switch to first visible POS tab only when:
  //  1. The POS terminal section is currently active (user already navigated to it), AND
  //  2. The sub-view that is currently shown has had its nav tab hidden by RBAC.
  // This must NOT fire on initial page load (where switchPOSView below handles the landing view).
  setTimeout(() => {
    const posTerminal = document.getElementById("pos-terminal");
    const isPOSActive = posTerminal && posTerminal.classList.contains("active");
    if (!isPOSActive) return; // not on POS terminal yet — role-based init handles it

    const currentView = document.querySelector(".pos-sub-view:not(.hidden)[style*='display: block'], .pos-sub-view:not(.hidden):not([style*='display: none'])");
    if (currentView) {
      const viewToNav = {
        "pos-register-view": "pos-nav-register",
        "pos-pending-view":  "pos-nav-pending",
        "pos-stock-view":    "pos-nav-stock",
        "pos-expenses-view": "pos-nav-expenses",
        "pos-credits-view":  "pos-nav-credits",
        "pos-finance-view":  "pos-nav-finance",
        "pos-hr-view":       "pos-nav-hr",
      };
      const navId = viewToNav[currentView.id];
      const navBtn = navId ? document.getElementById(navId) : null;
      if (navBtn && navBtn.style.display === "none") {
        // Current tab is now hidden — switch to first visible POS tab
        const posNavOrder = ["pos-nav-pending", "pos-nav-stock", "pos-nav-register", "pos-nav-expenses", "pos-nav-credits", "pos-nav-finance", "pos-nav-hr"];
        const firstVisibleTab = posNavOrder
          .map(id => document.getElementById(id))
          .find(btn => btn && btn.style.display !== "none");
        if (firstVisibleTab) firstVisibleTab.click();
      }
    }
  }, 100);

  // Default POS landing view per role — use 400ms so this always fires AFTER
  // the auto-switch above, ensuring the correct initial sub-view wins.
  if (isTech) {
    setTimeout(() => switchPOSView("tech"), 400);       // Tech → Tech Hub
  } else if (isWaiter) {
    setTimeout(() => switchPOSView("register"), 400);   // Waiter → Register only
  } else if (isCashier) {
    setTimeout(() => switchPOSView("register"), 400);   // Cashier → Register
  } else if (isAdminLike) {
    setTimeout(() => switchPOSView("pending"), 400);    // Admin-like → Pending tab (no register)
  } else if (isSupervisor) {
    setTimeout(() => switchPOSView("register"), 400);   // Supervisor → Register
  } else if (isHRRole) {
    setTimeout(() => switchPOSView("expenses"), 400);   // HR → Expenses
  }
}


async function fetchAuth(url, options = {}) {
  const token = localStorage.getItem("jomish_token");
  if (!options.headers) options.headers = {};
  options.headers["Authorization"] = `Bearer ${token}`;

  // Automatically add JSON header if there is a body and it's not already set
  if (options.body && !options.headers["Content-Type"]) {
    options.headers["Content-Type"] = "application/json";
  }

  if (
    localStorage.getItem("jomish_demo") === "true" &&
    options.method &&
    !["GET", "OPTIONS"].includes(options.method.toUpperCase())
  ) {
    // Silently mock success without throwing errors or toasts
    return new Response(
      JSON.stringify({
        success: true,
        message: "Demo mode simulated action",
        id: Date.now(),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const method = (options.method || "GET").toUpperCase();

  // --- OFFLINE & CACHE LOGIC ---
  if (method === "GET" && window.OfflineDB) {
    const cachedObj = await window.OfflineDB.getCachedApiResponse(url);
    const CACHE_TTL = 5 * 60 * 1000; // 5 minutes TTL for online caching

    // If offline, return cache if available
    if (!navigator.onLine) {
      if (cachedObj && cachedObj.data) {
        return new Response(JSON.stringify(cachedObj.data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("Offline and no cached data available for " + url);
    }

    // If online, use cache if it's fresh (less than 5 mins old) to save DB hits
    // (Bypass cache if url contains ?force=true or similar if needed in future)
    if (cachedObj && cachedObj.data && cachedObj.timestamp) {
      const age = Date.now() - cachedObj.timestamp;
      if (age < CACHE_TTL && !url.includes("force_refresh")) {
        console.log("[Cache Hit] Skipping network request for:", url);
        return new Response(JSON.stringify(cachedObj.data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
  } else if (!navigator.onLine && window.OfflineDB && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    // Queue offline mutations
    await window.OfflineDB.queueMutation(url, method, options);
    showToast(
      "Offline Mode: Action queued and will sync when online.",
      "info",
    );
    if (typeof window.updateAppOnlineStatus === "function") window.updateAppOnlineStatus();
    return new Response(
      JSON.stringify({
        success: true,
        message: "Offline queued action",
        offlineQueued: true,
        id: Date.now(),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const res = await fetch(url, options);
    if (res.status === 401) {
      try {
        await fetch(`${API_URL}/logout`, { method: "POST" });
      } catch (e) {}
      try {
        if (window.OfflineDB && typeof window.OfflineDB.clearAllCache === "function") {
          await window.OfflineDB.clearAllCache();
        }
      } catch (e) {}
      localStorage.clear();
      window.location.href = "login.html";
    }

    // If GET request is successful, clone and cache it
    if (method === "GET" && res.ok && window.OfflineDB) {
      const clone = res.clone();
      clone
        .json()
        .then((data) => {
          window.OfflineDB.cacheApiResponse(url, data);
        })
        .catch(() => {}); // Ignore parse errors for caching
    }

    // After a successful mutation, bust the relevant cache so data reflects immediately
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && res.ok && window.OfflineDB) {
      // Map URL patterns to the cache keys they affect
      const CACHE_BUST_MAP = [
        { pattern: "/products",       busts: ["/api/products", "/api/categories", "/api/reports/products-sold", "/reports/products-sold"] },
        { pattern: "/employees",      busts: ["/api/employees"] },
        { pattern: "/users/",         busts: ["/api/employees"] },
        { pattern: "/roles",          busts: ["/api/roles"] },
        { pattern: "/pos/cash-in",    busts: ["/api/transactions", "/api/finance"] },
        { pattern: "/cash-in",        busts: ["/api/transactions", "/api/finance"] },
        { pattern: "/transactions",   busts: ["/api/transactions", "/api/finance", "/api/deliveries", "/api/pos_orders", "/api/customer-invoices"] },
        { pattern: "/pos_orders",     busts: ["/api/pos_orders", "/api/transactions", "/api/deliveries", "/api/reports/products-sold", "/reports/products-sold"] },
        { pattern: "/checkout",       busts: ["/api/products", "/api/reports/products-sold", "/reports/products-sold", "/api/pos_orders", "/api/transactions", "/api/deliveries"] },
        { pattern: "/attendance",     busts: ["/api/attendance"] },
        { pattern: "/schedules",      busts: ["/api/schedules"] },
        { pattern: "/shift",          busts: ["/api/shifts", "/api/shift-assignments"] },
        { pattern: "/notices",        busts: ["/api/notices"] },
        { pattern: "/notes",          busts: ["/api/notes"] },
        { pattern: "/messages",       busts: ["/api/messages"] },
        { pattern: "/calendar",       busts: ["/api/calendar"] },
        { pattern: "/credits",        busts: ["/api/credits"] },
        { pattern: "/deliveries",     busts: ["/api/deliveries"] },
        { pattern: "/settings",       busts: ["/api/settings"] },
        { pattern: "/buyers",         busts: ["/api/buyers"] },
        { pattern: "/expense",        busts: ["/api/expense"] },
        { pattern: "/barcodes",       busts: ["/api/barcodes"] },
        { pattern: "/companies",      busts: ["/api/system/companies", "/api/tech/tenants"] },
        { pattern: "/tech/tenant",    busts: ["/api/system/companies", "/api/tech/tenants"] },
      ];

      for (const rule of CACHE_BUST_MAP) {
        if (url.includes(rule.pattern)) {
          for (const key of rule.busts) {
            window.OfflineDB.bustCache(key).catch(() => {});
          }
          break;
        }
      }
    }

    return res;
  } catch (e) {
    console.error("[Offline/Network Error]", e.message, url);
    // Fallback for fetch failure even if navigator.onLine was technically true
    if (method === "GET" && window.OfflineDB) {
      const cachedObj = await window.OfflineDB.getCachedApiResponse(url);
      if (cachedObj && cachedObj.data) {
        return new Response(JSON.stringify(cachedObj.data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    throw e; // Re-throw so callers can handle with their own try/catch
  }
}
window.fetchAuth = fetchAuth;

// --- OFFLINE SYNC ENGINE ---
async function syncQueuedMutations() {
  if (!window.OfflineDB) return;
  try {
    const mutations = await window.OfflineDB.getQueuedMutations();
    if (mutations.length === 0) return;

    console.log(
      `[Sync] Starting sync of ${mutations.length} queued mutations...`,
    );
    showToast(
      `Syncing ${mutations.length} pending actions to server...`,
      "info",
    );

    let successCount = 0;
    let failCount = 0;

    for (const mut of mutations) {
      try {
        const res = await fetch(mut.url, {
          method: mut.method,
          headers: mut.headers,
          body: mut.body,
        });

        if (res.ok || res.status === 400 || res.status === 409) {
          // Success or non-retriable error -> remove from queue
          await window.OfflineDB.removeQueuedMutation(mut.id);
          successCount++;
        } else {
          failCount++;
        }
      } catch (err) {
        console.warn(
          `[Sync] Mutation ${mut.id} failed to sync (will retry later):`,
          err,
        );
        failCount++;
      }
    }

    if (successCount > 0 && failCount === 0) {
      showToast(
        `All ${successCount} offline actions synced successfully!`,
        "success",
      );
    } else if (failCount > 0) {
      showToast(
        `${successCount} synced, ${failCount} failed (will retry).`,
        "warning",
      );
    }

    // Refresh data if needed
    if (successCount > 0) {
      if (
        typeof loadTransactions === "function" &&
        USER_PERMISSIONS.can_see_sme
      )
        loadTransactions();
      if (typeof loadDashboard === "function") loadDashboard();
    }

    // Update banner if still offline or queue not empty
    if (!navigator.onLine) {
      const banner = document.getElementById("app-offline-banner");
      if (banner) {
        const remaining = await window.OfflineDB.getPendingSyncCount();
        banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Offline Mode — ${remaining} actions pending sync`;
      }
    }
  } catch (e) {
    console.error("[Sync] Engine error:", e);
  }
}
window.syncQueuedMutations = syncQueuedMutations;

async function loadEmployees() {
  if (USER_ROLE === "Security") return;
  try {
    const res = await fetchAuth(`${API_URL}/employees`);
    const data = await res.json();
    // Cache employees globally so shift modal can use them as fallback
    if (data.employees && data.employees.length > 0) {
      window.EMPLOYEES_CACHE = data.employees;
    }
    const tbody = document.querySelector("#employees-table tbody");
    tbody.innerHTML = "";
    data.employees.forEach((emp) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
                <td>ID-${emp.id}</td>
                <td>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="width:10px; height:10px; border-radius:50%; background:${emp.is_present ? "#10B981" : "#EF4444"};"></div>
                        <span>${emp.first_name} ${emp.last_name}</span>
                        ${emp.is_sick ? '<span style="font-size:0.6rem; background:#fee2e2; color:#ef4444; padding:2px 6px; border-radius:4px;">SICK</span>' : ""}
                        ${emp.is_suspended ? '<span style="font-size:0.6rem; background:var(--danger); color:white; padding:2px 6px; border-radius:4px;">SUSPENDED</span>' : ""}
                    </div>
                </td>
                <td>${emp.email || "-"}</td>
                <td>${emp.role}</td>
                <td>${emp.department || "-"}</td>
                <td>UGX ${emp.salary ? emp.salary.toLocaleString() : "0"}</td>
                <td>
                    <div style="display:flex; gap:5px;">
                        <button class="sm-btn success" onclick="generateIDCard(${JSON.stringify(emp).replace(/"/g, "&quot;")})">ID Card</button>
                        <button class="sm-btn secondary" onclick="openEmployeeNotes(${emp.id}, '${emp.first_name}')">Notes</button>
                        ${
                          ["CEO", "HR", "SUPERVISOR", "MANAGER", "ADMIN"].includes(
                            (USER_ROLE || "").toUpperCase()
                          )
                            ? `
                            <button class="sm-btn ${emp.is_sick ? "success" : "danger"}" onclick="toggleSick(${emp.id}, ${emp.is_sick ? 0 : 1})">
                                ${emp.is_sick ? "Mark Healthy" : "Report Sick"}
                            </button>
                            ${
                              ["CEO", "HR", "MANAGER", "ADMIN"].includes((USER_ROLE || "").toUpperCase())
                                ? `
                                <button class='sm-btn warning' onclick="openAdminChangePinModal(${emp.id}, '${(emp.first_name + ' ' + (emp.last_name || '')).trim().replace(/'/g, "\\'")}')" title="Change Staff PIN"><i class="fa-solid fa-key"></i> Change PIN</button>
                                <button class='sm-btn primary' onclick="openPassModal(${JSON.stringify(emp).replace(/"/g, "&quot;")})" title="Edit Access, Role, and Termination"><i class="fa-solid fa-user-gear"></i> Edit Access</button>
                            `
                                : ""
                            }
                        `
                            : ""
                        }
                    </div>
                </td>
            `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error(e);
  }
}

// ── ADMIN CHANGE STAFF PIN MODAL HELPERS ─────────────────────────────
window.openAdminChangePinModal = function(empId, staffName) {
  const empInput = document.getElementById("admin-change-pin-emp-id");
  const nameEl = document.getElementById("admin-change-pin-staff-name");
  const pinInput = document.getElementById("admin-change-pin-input");
  const errEl = document.getElementById("admin-change-pin-error");
  if (empInput) empInput.value = empId;
  if (nameEl) nameEl.textContent = staffName || `Staff #${empId}`;
  if (pinInput) pinInput.value = "";
  if (errEl) { errEl.style.display = "none"; errEl.textContent = ""; }

  const modal = document.getElementById("admin-change-pin-modal");
  if (modal) modal.classList.remove("hidden");
  setTimeout(() => pinInput && pinInput.focus(), 100);
};

window.closeAdminChangePinModal = function() {
  const modal = document.getElementById("admin-change-pin-modal");
  if (modal) modal.classList.add("hidden");
};

window.generateStaffPinAuto = function() {
  const pin = String(Math.floor(1000 + Math.random() * 9000));
  const pinInput = document.getElementById("admin-change-pin-input");
  if (pinInput) pinInput.value = pin;
};

window.submitAdminChangePin = async function() {
  const empId = document.getElementById("admin-change-pin-emp-id").value;
  const pin = document.getElementById("admin-change-pin-input").value.trim();
  const staffName = document.getElementById("admin-change-pin-staff-name").textContent;
  const errEl = document.getElementById("admin-change-pin-error");
  const btn = document.getElementById("btn-submit-admin-pin");

  if (!pin || pin.length < 4) {
    if (errEl) {
      errEl.textContent = "Please enter a PIN with at least 4 digits.";
      errEl.style.display = "block";
    }
    return;
  }

  const origHtml = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...'; }

  try {
    const res = await fetchAuth(`${API_URL}/employees/${empId}/pin`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`PIN for ${staffName} updated successfully!`, "success");
      closeAdminChangePinModal();
      loadEmployees();
    } else {
      if (errEl) {
        errEl.textContent = data.error || "Failed to update PIN.";
        errEl.style.display = "block";
      } else {
        alert(data.error || "Failed to update PIN.");
      }
    }
  } catch (e) {
    console.error("Error changing staff PIN:", e);
    if (errEl) {
      errEl.textContent = "Network error while saving PIN.";
      errEl.style.display = "block";
    }
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = origHtml || '<i class="fa-solid fa-check"></i> Save PIN'; }
  }
};

async function deleteEmployee(id) {
  const confirmed = confirm(
    "  TERMINATION CONFIRMATION\n\n" +
      "This action will:\n" +
      "  • Permanently DELETE this employee record\n" +
      "  • Revoke their ID / QR access and login account\n\n" +
      "Proceed to terminate and delete this staff member?",
  );
  if (!confirmed) return;

  try {
    try {
      const saved = JSON.parse(localStorage.getItem("jomish_saved_users") || "[]");
      const filtered = saved.filter(u => u.id !== id && u.id !== Number(id));
      localStorage.setItem("jomish_saved_users", JSON.stringify(filtered));
    } catch (_) {}

    const res = await fetchAuth(`${API_URL}/employees/${id}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (res.ok) {
      showToast(
        "Employee terminated and permanently deleted.",
        "success",
      );
      loadEmployees();
      loadDashboard();
      document.getElementById("set-password-modal").classList.add("hidden");
    } else {
      showToast(
        data.error || "Failed to delete employee",
        "danger",
      );
    }
  } catch (e) {
    console.error(e);
    showToast(`Network error. Please check server connection.`, "danger");
  }
}

async function handleSuspendAccount() {
  const id = document.getElementById("pass-emp-id").value;
  if (!id) return;
  if (
    !confirm(
      "Suspend this account? The employee will be immediately locked out until restored.",
    )
  )
    return;

  try {
    const res = await fetchAuth(`${API_URL}/employees/${id}/suspend`, {
      method: "PATCH",
    });
    if (res.ok) {
      showToast("Account suspended successfully.", "success");
      document.getElementById("set-password-modal").classList.add("hidden");
      loadEmployees();
    } else {
      const err = await res.json();
      alert(err.error || "Failed to suspend account.");
    }
  } catch (e) {
    console.error(e);
  }
}

async function handleRestoreAccount() {
  const id = document.getElementById("pass-emp-id").value;
  if (!id) return;
  if (
    !confirm(
      "Restore this account? The employee will regain login access immediately.",
    )
  )
    return;

  try {
    const res = await fetchAuth(`${API_URL}/employees/${id}/unsuspend`, {
      method: "PATCH",
    });
    if (res.ok) {
      showToast("Account restored successfully.", "success");
      document.getElementById("set-password-modal").classList.add("hidden");
      loadEmployees();
    } else {
      const err = await res.json();
      alert(err.error || "Failed to restore account.");
    }
  } catch (e) {
    console.error(e);
  }
}

async function handleDeleteAccount() {
  const id = document.getElementById("pass-emp-id").value;
  if (id) deleteEmployee(id);
}

// ―――― Toast Notification Helper ―――――――――――――――――――――――――――――――――――――――――――――――――――――――
function showToast(message, type = "success") {
  // Remove any existing toast
  const old = document.getElementById("jomish-toast");
  if (old) old.remove();

  const colors = {
    success: {
      bg: "rgba(16,185,129,0.15)",
      border: "#10B981",
      text: "#6EE7B7",
    },
    danger: { bg: "rgba(239,68,68,0.15)", border: "#EF4444", text: "#FCA5A5" },
    warning: {
      bg: "rgba(245,158,11,0.15)",
      border: "#F59E0B",
      text: "#FCD34D",
    },
    info: { bg: "rgba(99,102,241,0.15)", border: "#6366F1", text: "#A5B4FC" },
  };
  const c = colors[type] || colors.info;

  const toast = document.createElement("div");
  toast.id = "jomish-toast";
  toast.style.cssText = `
        position: fixed; bottom: 28px; right: 28px; z-index: 99999;
        background: ${c.bg}; border: 1px solid ${c.border}; color: ${c.text};
        padding: 14px 22px; border-radius: 12px; font-size: 0.9rem; font-weight: 600;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4); backdrop-filter: blur(12px);
        max-width: 380px; line-height: 1.4;
        animation: toastIn 0.35s cubic-bezier(0.23,1,0.32,1) both;
    `;
  toast.textContent = message;

  // Inject keyframe if not already present
  if (!document.getElementById("toast-keyframe-style")) {
    const style = document.createElement("style");
    style.id = "toast-keyframe-style";
    style.textContent = `
            @keyframes toastIn  { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:translateY(0); } }
            @keyframes toastOut { from { opacity:1; transform:translateY(0); } to { opacity:0; transform:translateY(16px); } }
        `;
    document.head.appendChild(style);
  }

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = "toastOut 0.3s ease forwards";
    setTimeout(() => toast.remove(), 320);
  }, 4000);
}
window.showToast = showToast;

async function toggleSick(id, state) {
  if (!confirm(`Mark this staff member as ${state ? "SICK" : "HEALTHY"}?`))
    return;
  try {
    const res = await fetchAuth(`${API_URL}/employees/sick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employee_id: id, is_sick: state }),
    });
    if (res.ok) {
      loadEmployees();
      loadDashboard(); // Update presence stats
    } else {
      const data = await res.json();
      alert(data.error || "Failed to update health status");
    }
  } catch (e) {
    console.error(e);
  }
}

// viewEmployeeNotes is now handled by openEmployeeNotes() which uses the real notes API & modal

// ==== MONTHLY PAYROLL LOGIC ====
let _payrollCache = []; // stores last-loaded payroll data for printing

async function loadPayrollStatus() {
  const month = document.getElementById("payroll-month").value;
  if (!month) return;

  try {
    const res = await fetchAuth(`${API_URL}/payroll/status?month=${month}`);
    const data = await res.json();
    const tbody = document.getElementById("payroll-tbody");
    tbody.innerHTML = "";

    if (!data.employees || data.employees.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="5" style="text-align:center; padding:30px; color:#94A3B8;">No employees with a configured salary found.</td></tr>';
      return;
    }

    _payrollCache = data.employees; // cache for printPayrollList

    data.employees.forEach((emp) => {
      const tr = document.createElement("tr");

      const paidAmount = emp.paid_amount || 0;
      const arrears = emp.arrears || 0;
      const totalDue = emp.total_due || emp.salary;
      const balance = totalDue - paidAmount;

      const isFullyPaid = balance <= 0;
      const isPartiallyPaid = paidAmount > 0 && !isFullyPaid;

      let statusBadge = "";
      if (isFullyPaid) {
        statusBadge = `<span style="background: rgba(34,197,94,0.1); color: #22c55e; padding: 4px 8px; border-radius: 6px; font-size: 0.8rem; font-weight: 600;">Fully Paid</span>`;
      } else if (isPartiallyPaid) {
        statusBadge = `<span style="background: rgba(245,158,11,0.1); color: #f59e0b; padding: 4px 8px; border-radius: 6px; font-size: 0.8rem; font-weight: 600;">Advance Paid</span>`;
      } else {
        statusBadge = `<span style="background: rgba(239,68,68,0.1); color: #ef4444; padding: 4px 8px; border-radius: 6px; font-size: 0.8rem; font-weight: 600;">Unpaid</span>`;
      }

      // Calculate Pay Date and Due Notice
      const createdDate = new Date(emp.created_at || new Date());
      const [selYear, selMonth] = month.split("-");
      const dueDate = new Date(
        selYear,
        parseInt(selMonth) - 1,
        createdDate.getDate(),
      );
      const dueStr = dueDate.toLocaleDateString();

      let dueNotice = "";
      if (!isFullyPaid) {
        const today = new Date();
        const diffTime = dueDate.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays <= 3 && diffDays >= 0) {
          dueNotice = `<div style="font-size:0.75rem; color:#f59e0b; font-weight:bold; margin-top:4px;"><i class="fa-solid fa-triangle-exclamation"></i> Due in ${diffDays} day(s)</div>`;
        } else if (diffDays < 0) {
          dueNotice = `<div style="font-size:0.75rem; color:#ef4444; font-weight:bold; margin-top:4px;"><i class="fa-solid fa-triangle-exclamation"></i> Overdue by ${Math.abs(diffDays)} day(s)</div>`;
        }
      }

      let actionBtn = isFullyPaid
        ? `<button class="secondary-btn sm-btn" onclick="printPayrollSlip('${emp.first_name} ${emp.last_name}', '${emp.role}', ${paidAmount}, '${month}', '${emp.paid_at}')"><i class="fa-solid fa-print"></i> View Slip</button>`
        : `<div style="display:flex; flex-direction:column; gap:5px;">
                     <div style="display:flex; gap:5px; align-items:center;">
                         <input type="number" id="pay-amt-${emp.id}" value="${balance}" max="${balance}" min="1" class="form-control" style="width:100px; padding:5px; font-size:0.8rem;" title="Enter amount for pay advance or full payment">
                         <button class="primary-btn sm-btn" onclick="processPayroll(${emp.id}, '${emp.first_name} ${emp.last_name}')"><i class="fa-solid fa-money-check-dollar"></i> Pay</button>
                     </div>
                   </div>`;

      if (isPartiallyPaid) {
        actionBtn += `<div style="margin-top:5px;"><button class="secondary-btn sm-btn" onclick="printPayrollSlip('${emp.first_name} ${emp.last_name}', '${emp.role}', ${paidAmount}, '${month}', '${emp.paid_at}')"><i class="fa-solid fa-print"></i> Slip So Far</button></div>`;
      }

      tr.innerHTML = `
                <td>
                    <div style="font-weight:600;">${emp.first_name} ${emp.last_name}</div>
                    <div style="font-size:0.75rem; color:#94A3B8;">Due: ${dueStr}</div>
                    ${dueNotice}
                </td>
                <td>${emp.role}</td>
                <td>
                    <div style="font-weight: 600;">UGX ${emp.salary.toLocaleString()} /mo</div>
                    ${arrears > 0 ? `<div style="font-size:0.75rem; color:#f59e0b;">Arrears: UGX ${arrears.toLocaleString()}</div>` : ""}
                    <div style="font-size:0.8rem; font-weight:bold; margin-top:2px;">Total Owed: UGX ${totalDue.toLocaleString()}</div>
                    ${paidAmount > 0 ? `<div style="font-size:0.75rem; color:#22c55e;">Paid: UGX ${paidAmount.toLocaleString()}</div>` : ""}
                    ${balance > 0 ? `<div style="font-size:0.75rem; color:#ef4444;">Bal: UGX ${balance.toLocaleString()}</div>` : ""}
                </td>
                <td>${statusBadge}</td>
                <td>${actionBtn}</td>
            `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error("Payroll load error:", e);
  }
}

async function processPayroll(empId, empName) {
  const month = document.getElementById("payroll-month").value;
  if (!month) return alert("Please select a month first.");

  const amtInput = document.getElementById(`pay-amt-${empId}`);
  const amount = amtInput ? parseFloat(amtInput.value) : 0;

  if (!amount || amount <= 0) return alert("Please enter a valid amount.");

  if (
    !confirm(
      `Are you sure you want to process payroll for ${empName}?\nAmount: UGX ${amount.toLocaleString()}\nMonth: ${month}\n\nThis will record an expense in the SME portal.`,
    )
  )
    return;

  try {
    const res = await fetchAuth(`${API_URL}/payroll`, {
      method: "POST",
      body: JSON.stringify({
        employee_id: empId,
        month_year: month,
        amount: amount,
      }),
    });
    const data = await res.json();

    if (res.ok) {
      showToast(`Payroll processed for ${empName}!`, "success");
      loadPayrollStatus();
      printPayrollSlip(
        empName,
        "Employee",
        amount,
        month,
        new Date().toISOString(),
      );
    } else {
      alert(data.error);
    }
  } catch (e) {
    console.error("Payroll process error:", e);
  }
}

function printPayrollSlip(empName, role, amount, month, datePaid) {
  let printArea = document.getElementById("statement-print-area");
  if (!printArea) {
    printArea = document.createElement("div");
    printArea.id = "statement-print-area";
    printArea.style.display = "none";
    document.body.appendChild(printArea);
  }

  printArea.innerHTML = `
        <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px; border: 1px solid #ccc;">
            <h2 style="text-align: center; margin-bottom: 5px;">JOMISH SUITE</h2>
            <h3 style="text-align: center; margin-top: 0; color: #555;">PAYROLL SLIP</h3>
            <hr>
            <p><strong>Employee:</strong> ${empName}</p>
            <p><strong>Role:</strong> ${role}</p>
            <p><strong>Pay Period:</strong> ${month}</p>
            <p><strong>Paid On:</strong> ${new Date(datePaid).toLocaleString()}</p>
            <hr>
            <h3 style="margin-top: 15px;">NET PAY: <span style="float: right;">UGX ${amount.toLocaleString()}</span></h3>
            <br><br><br>
            <p>Received By (Signature): _______________________</p>
            <br>
            <p style="text-align: center; font-size: 0.8rem; color: #888;">Official Payroll Record<br>Auto-generated by Jomish Business Suite</p>
        </div>
    `;

  clearAllPrintModes();
  document.body.classList.add("print-mode-statement");
  window.print();
  setTimeout(() => {
    clearAllPrintModes();
  }, 1500);
}

function printPayrollList() {
  if (_payrollCache.length === 0) {
    showToast("Load payroll data first by selecting a month.", "warning");
    return;
  }

  const filterEl = document.getElementById("payroll-print-filter");
  const filter = filterEl ? filterEl.value : "all";
  const monthEl = document.getElementById("payroll-month");
  const month = monthEl ? monthEl.value : "";

  let rows = _payrollCache;
  if (filter === "paid") rows = rows.filter((e) => !!e.paid_at);
  if (filter === "unpaid") rows = rows.filter((e) => !e.paid_at);

  if (rows.length === 0) {
    showToast(`No ${filter} employees to print.`, "info");
    return;
  }

  const labelMap = {
    all: "All Employees",
    paid: "Paid Employees",
    unpaid: "Unpaid Employees",
  };
  const filterLabel = labelMap[filter] || "All Employees";

  let html = `
        <div style="font-family: sans-serif; padding: 20px;">
            <h2 style="text-align: center; margin-bottom: 5px;">JOMISH BUSINESS SUITE</h2>
            <h3 style="text-align: center; margin-top: 0; color: #555;">Payroll Report – ${filterLabel}</h3>
            ${month ? `<p style="text-align: center; font-weight: bold;">Period: ${month}</p>` : ""}
            <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
                <thead>
                    <tr style="background-color: #4F46E5; color: white;">
                        <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Employee Name</th>
                        <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Role</th>
                        <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Base Salary</th>
                        <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Status</th>
                        <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Date Paid</th>
                    </tr>
                </thead>
                <tbody>
    `;

  let totalPaid = 0;
  let totalUnpaid = 0;

  rows.forEach((emp, idx) => {
    const isPaid = !!emp.paid_at;
    const bg = idx % 2 === 0 ? "#f9f9f9" : "#ffffff";

    if (isPaid) {
      totalPaid += emp.paid_amount || emp.salary || 0;
    } else {
      totalUnpaid += emp.salary || 0;
    }

    html += `
            <tr style="background-color: ${bg};">
                <td style="padding: 10px; border: 1px solid #ddd;">${emp.first_name || ""} ${emp.last_name || ""}</td>
                <td style="padding: 10px; border: 1px solid #ddd;">${emp.role || "-"}</td>
                <td style="padding: 10px; border: 1px solid #ddd;">UGX ${(emp.salary || 0).toLocaleString()}</td>
                <td style="padding: 10px; border: 1px solid #ddd; color: ${isPaid ? "#22c55e" : "#ef4444"}; font-weight: bold;">${isPaid ? "Paid" : "Unpaid"}</td>
                <td style="padding: 10px; border: 1px solid #ddd;">${isPaid ? new Date(emp.paid_at).toLocaleDateString() : "—"}</td>
            </tr>
        `;
  });

  html += `
                </tbody>
            </table>
            <div style="margin-top: 20px; display: flex; justify-content: space-between; font-weight: bold; font-size: 1.1rem;">
                ${filter !== "unpaid" ? `<div>Total Paid: UGX ${totalPaid.toLocaleString()}</div>` : "<div></div>"}
                ${filter !== "paid" ? `<div>Total Unpaid: UGX ${totalUnpaid.toLocaleString()}</div>` : ""}
            </div>
            <p style="text-align: center; margin-top: 40px; font-size: 0.8rem; color: #888;">
                Printed on ${new Date().toLocaleString()} – Jomish Business Suite
            </p>
        </div>
    `;

  let printArea = document.getElementById("statement-print-area");
  if (!printArea) {
    printArea = document.createElement("div");
    printArea.id = "statement-print-area";
    printArea.style.display = "none";
    document.body.appendChild(printArea);
  }

  printArea.innerHTML = html;

  clearAllPrintModes();
  document.body.classList.add("print-mode-statement");
  window.print();
  setTimeout(() => {
    clearAllPrintModes();
  }, 1500);
}

// ─── Populate any role <select> from live DB ──────────────────────────────────
async function loadRolesIntoSelect(selectId, currentValue = "") {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  try {
    const r = await fetchAuth(`${API_URL}/roles`);
    const data = await r.json();
    const roles = (data.roles || [])
      .map((r) => r.role_name)
      .filter(Boolean)
      .sort();
    sel.innerHTML = '<option value="">-- Select Role --</option>';
    roles.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === currentValue) opt.selected = true;
      sel.appendChild(opt);
    });
  } catch (e) {
    sel.innerHTML = '<option value="">-- Failed to load roles --</option>';
  }
}

async function handleAddEmployee(e) {
  e.preventDefault();
  // Support optional photo field (may not exist in POS HR view)
  const photoInput = document.getElementById("emp-photo");
  let photoBase64 = null;

  if (photoInput && photoInput.files && photoInput.files[0]) {
    const file = photoInput.files[0];
    if (file.size > 5 * 1024 * 1024) {
      alert("Image too large! Please select a photo under 5MB.");
      return;
    }
    photoBase64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (ev) => resolve(ev.target.result);
      reader.readAsDataURL(file);
    });
  }

  // Support both old field IDs (emp-first / emp-last / emp-dept) and new ones (emp-first-name / emp-last-name / emp-department)
  const firstNameEl = document.getElementById("emp-first-name") || document.getElementById("emp-first");
  const lastNameEl  = document.getElementById("emp-last-name")  || document.getElementById("emp-last");
  const deptEl      = document.getElementById("emp-department") || document.getElementById("emp-dept");
  const usernameEl  = document.getElementById("emp-username");
  const emailInput  = (document.getElementById("emp-email")?.value || "").trim();

  const empColor = localStorage.getItem("jomish_biz_color") || "#4F46E5";

  const payload = {
    first_name:    firstNameEl ? firstNameEl.value : "",
    last_name:     lastNameEl  ? lastNameEl.value  : "",
    email:         emailInput  || undefined,
    username:      usernameEl  ? usernameEl.value  : undefined,
    role:          document.getElementById("emp-role").value,
    department:    deptEl ? deptEl.value : "",
    salary:        parseFloat(document.getElementById("emp-salary")?.value) || 0,
    profile_color: empColor,
    photo_base64:  photoBase64,
    password:      document.getElementById("emp-password").value,
  };

  const submitBtn = e.target.querySelector("button[type='submit']");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
  }

  try {
    const res = await fetchAuth(`${API_URL}/employees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) {
      document.getElementById("add-employee-modal").classList.add("hidden");
      document.getElementById("form-add-employee").reset();
      loadEmployees();
      showToast(
        `✅ ${data.first_name} ${data.last_name} added! Login ID: ${data.employee_code}`,
        "success",
      );
      generateIDCard(data);
    } else {
      alert(
        "Add Staff Error: " +
          (data.error ||
            "Check if email is already in use or photo is too large."),
      );
    }
  } catch (err) {
    console.error(err);
    alert(
      "Network Error: Please ensure you have launched the server using Launch_Jomish_Suite.bat.",
    );
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Save Employee';
    }
  }
}

// --- Robust barcode renderer: retries until JsBarcode is available (handles defer load race) ---
function drawBarcode(svgSelector, value, attempt) {
  attempt = attempt || 0;
  const svgEl = document.querySelector(svgSelector);
  if (!svgEl) return;

  // Clear previous barcode stripes
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

  if (typeof JsBarcode === "undefined") {
    if (attempt < 20) {
      setTimeout(() => drawBarcode(svgSelector, value, attempt + 1), 100);
    } else {
      console.warn("JsBarcode unavailable after retries");
    }
    return;
  }

  // Sanitize value — CODE128 can't handle null/undefined/empty
  const safeVal = (value || "EMP-0").replace(/[^\x20-\x7E]/g, "");
  if (!safeVal) return;

  try {
    JsBarcode(svgSelector, safeVal, {
      format: "CODE128",
      displayValue: true,
      fontSize: 9,
      textMargin: 2,
      width: 1.4,
      height: 32,
      margin: 3,
      background: "#ffffff",
      lineColor: "#000000",
    });
  } catch (e) {
    console.warn("JsBarcode draw error:", e.message || e);
  }
}

function generateIDCard(emp) {
  const overlay = document.getElementById("print-overlay");
  if (!overlay) return;

  // Set dynamic background color based on profile_color
  const cardFront = document.getElementById("id-card-front");
  if (cardFront) {
    const color = emp.profile_color || "#1e3a8a";
    cardFront.style.background = `linear-gradient(135deg, ${color}, #000000)`;
  }

  // Always fetch fresh business settings from the server (never use stale localStorage)
  fetchAuth(`${API_URL}/settings/all`)
    .then((r) => r.json())
    .then((settings) => {
      // In global tech mode, don't show any company branding on ID cards
      if (settings._is_global_tech) {
        settings.business_name = "Jomish Business Suite";
        settings.business_contact = "";
        settings.business_location = "";
      }
      const bizName = (
        settings.business_name ||
        localStorage.getItem("jomish_biz_name") ||
        "JOMISH SUITE"
      ).toUpperCase();
      const contact =
        settings.business_contact ||
        localStorage.getItem("jomish_biz_contact") ||
        "";
      const location =
        settings.business_location ||
        localStorage.getItem("jomish_biz_location") ||
        "";

      // Update localStorage with fresh data
      if (settings.business_name)
        localStorage.setItem("jomish_biz_name", settings.business_name);
      if (settings.business_contact)
        localStorage.setItem("jomish_biz_contact", settings.business_contact);
      if (settings.business_location)
        localStorage.setItem("jomish_biz_location", settings.business_location);

      const elBizName = document.getElementById("id-biz-name-front");
      if (elBizName)
        elBizName.innerHTML = `<i class="fa-solid fa-circle-nodes"></i> ${bizName}`;

      const elBizNameBack = document.getElementById("id-biz-name-back");
      if (elBizNameBack)
        elBizNameBack.innerHTML = `<i class="fa-solid fa-circle-nodes"></i> ${bizName}`;

      // Employee name & role
      const elName = document.getElementById("print-emp-name-front");
      if (elName)
        elName.textContent =
          `${emp.first_name || ""} ${emp.last_name || ""}`.trim() ||
          emp.name ||
          "Unknown";

      const elRole = document.getElementById("print-emp-role-front");
      if (elRole) elRole.textContent = emp.role || "Staff";

      // Business contact (phone) on front — this is the BUSINESS phone, not employee
      const elContact = document.getElementById("id-contact-info");
      if (elContact)
        elContact.innerHTML = `<i class="fa-solid fa-phone"></i> ${contact}`;

      const elContactBack = document.getElementById("id-contact-back");
      if (elContactBack) elContactBack.textContent = contact;

      // Employee email (their own email)
      const elEmail = document.getElementById("id-email-info");
      if (elEmail)
        elEmail.innerHTML = `<i class="fa-solid fa-envelope"></i> ${emp.email || ""}`;

      // Business location
      const elLocation = document.getElementById("id-location-info");
      if (elLocation)
        elLocation.innerHTML = `<i class="fa-solid fa-location-dot"></i> ${location}`;

      const elLocationBack = document.getElementById("id-location-back");
      if (elLocationBack) elLocationBack.textContent = location;

      // Profile photo
      const elPhotoFront = document.getElementById("id-profile-img-front");
      if (elPhotoFront) {
        elPhotoFront.src =
          emp.photo_base64 || emp.photo
            ? emp.photo_base64 || emp.photo
            : "lib/placeholder.png";
        elPhotoFront.onerror = () => {
          elPhotoFront.src = "lib/placeholder.png";
        };
      }

      overlay.classList.add("receipt-modal-visible");
      document.body.classList.add("print-mode-id");

      // Barcode — drawn AFTER modal is visible so SVG has real dimensions
      drawBarcode("#id-barcode-front", emp.employee_code || `EMP-${emp.id}`);
    })
    .catch(() => {
      // Fallback — use localStorage if fetch fails
      const bizName = (
        localStorage.getItem("jomish_biz_name") || "JOMISH SUITE"
      ).toUpperCase();
      const elBizName = document.getElementById("id-biz-name-front");
      if (elBizName)
        elBizName.innerHTML = `<i class="fa-solid fa-circle-nodes"></i> ${bizName}`;
      overlay.classList.add("receipt-modal-visible");
      document.body.classList.add("print-mode-id");
      drawBarcode("#id-barcode-front", emp.employee_code || `EMP-${emp.id}`);
    });
}

// Helper: Strip ALL print-mode classes to prevent cross-overlay bleeding
function clearAllPrintModes() {
  document.body.classList.remove(
    "print-mode-id",
    "print-mode-receipt",
    "print-mode-label",
    "print-mode-timetable",
    "print-mode-statement",
  );
}

function doPrintID() {
  if (isPrinting) return;
  isPrinting = true;

  clearAllPrintModes();
  document.body.classList.add("print-mode-id");

  // Dynamically inject exact CR80 @page style to prevent conflicts with A4 or receipt rolls
  const style = document.createElement("style");
  style.id = "dynamic-print-page-style";
  style.innerHTML = `@page { size: 85.6mm 54mm; margin: 0; }`;
  document.head.appendChild(style);

  window.print();

  // Clean up style override immediately after print dialog resolves
  style.remove();

  // Release print lock after a delay to absorb touchscreen click events
  setTimeout(() => {
    isPrinting = false;
  }, 1500);
}

function closeIDCard() {
  const overlay = document.getElementById("print-overlay");
  if (overlay) overlay.classList.remove("receipt-modal-visible");
  document.body.classList.remove("print-mode-id");

  const elName = document.getElementById("print-emp-name-front");
  if (elName) elName.textContent = "";

  const elRole = document.getElementById("print-emp-role-front");
  if (elRole) elRole.textContent = "";

  const elIdBack = document.getElementById("print-emp-id-back");
  if (elIdBack) elIdBack.textContent = "";

  const elPhoto = document.getElementById("id-profile-img-front");
  if (elPhoto) elPhoto.src = "lib/placeholder.png";
}

function getCategoryIcon(cat) {
  const c = String(cat || "General").toLowerCase();
  if (c.includes("beverage") || c.includes("drink") || c.includes("water"))
    return '<i class="fa-solid fa-cup-togo"></i>';
  if (c.includes("food") || c.includes("meal"))
    return '<i class="fa-solid fa-bowl-food"></i>';
  if (c.includes("pastry") || c.includes("bread") || c.includes("cake"))
    return '<i class="fa-solid fa-bread-slice"></i>';
  if (c.includes("service")) return '<i class="fa-solid fa-wrench"></i>';
  return '<i class="fa-solid fa-box"></i>';
}

// ==== POS HANDLERS & RECEIPT ====
// In-flight guard: if a load is already running, queue at most one pending call
let _posProductsLoading = false;
let _posProductsPendingSearch = null; // last queued searchTerm while load was in progress
let _posProductsRetryTimer = null;

async function loadPOSProducts(searchTerm = "") {
  // If a fetch is already in flight, just remember the latest search term and return.
  // When the in-flight fetch completes it will re-run with the queued term.
  if (_posProductsLoading) {
    _posProductsPendingSearch = searchTerm;
    return;
  }

  _posProductsLoading = true;
  clearTimeout(_posProductsRetryTimer);

  try {
    if (window.OfflineDB && typeof window.OfflineDB.bustCache === "function") {
      await window.OfflineDB.bustCache("/api/products").catch(() => {});
    }
    const res = await fetchAuth(`${API_URL}/products?force_refresh=true&_t=${Date.now()}`);

    if (res.status === 429) {
      // Rate limited — keep the current grid intact and silently retry after 3 s
      console.warn("[POS] Rate limited on /products — retrying in 3s");
      _posProductsRetryTimer = setTimeout(() => loadPOSProducts(searchTerm), 3000);
      return;
    }

    if (!res.ok) {
      // Any other server error — fall back to the last good product list if we have it,
      // otherwise show a non-intrusive toast (no alert, no blank screen)
      const body = await res.json().catch(() => ({}));
      console.error("[POS] Products load error:", body.error || res.status);
      if (cachedProducts && cachedProducts.length > 0) {
        // Re-render from cache so the cashier can still work
        _renderPOSGrid(cachedProducts, searchTerm);
      } else {
        showToast("Couldn't load products. Retrying…", "warning");
        _posProductsRetryTimer = setTimeout(() => loadPOSProducts(searchTerm), 4000);
      }
      return;
    }

    const data = await res.json();
    cachedProducts = data.products || []; // Refresh cache for barcode scanner
    _renderPOSGrid(cachedProducts, searchTerm);

  } catch (e) {
    console.error("[POS] Products network error:", e.message);
    // Network/fetch failure — fall back to cached data silently
    if (cachedProducts && cachedProducts.length > 0) {
      _renderPOSGrid(cachedProducts, searchTerm);
    } else {
      showToast("Network error loading products. Retrying…", "warning");
      _posProductsRetryTimer = setTimeout(() => loadPOSProducts(searchTerm), 4000);
    }
  } finally {
    _posProductsLoading = false;
    // If a call was queued while we were loading, run it now
    if (_posProductsPendingSearch !== null) {
      const nextSearch = _posProductsPendingSearch;
      _posProductsPendingSearch = null;
      loadPOSProducts(nextSearch);
    }
  }
}

function _renderPOSGrid(products, searchTerm = "") {
  const grid = document.getElementById("pos-products");
  if (!grid) return;

  let filtered = products;
  if (searchTerm) {
    const lowTerm = searchTerm.toLowerCase();
    filtered = filtered.filter(
      (p) =>
        (p.name || "").toLowerCase().includes(lowTerm) ||
        (p.category || "").toLowerCase().includes(lowTerm),
    );
  }

  if (filtered.length === 0) {
    grid.innerHTML =
      '<div style="grid-column: 1/-1; padding: 40px; text-align: center; color: var(--text-muted);"><h3>No Items Found</h3><p>Try searching for something else or check your inventory.</p></div>';
    return;
  }

  grid.innerHTML = "";
  filtered.forEach((p) => {
    const prodName = p.name || "Unnamed";
    const prodPrice = Number(p.price) || 0;
    const prodStock = Number(p.stock) || 0;
    const prodCat = p.category || "General";
    const isUnlimited = p.track_stock === 0;

    const card = document.createElement("div");
    card.className = `product-card ${!isUnlimited && prodStock <= 0 ? "empty" : ""}`;

    const catClass = `category-${prodCat.toLowerCase()}`;
    let imageHtml;
    if (p.photo_base64 && p.photo_base64.length > 50) {
      imageHtml = `<div class="product-img-container">
                    <img src="${p.photo_base64}" alt="${prodName}" loading="lazy">
                </div>`;
    } else if (p.has_photo) {
      imageHtml = `<div class="product-img-container">
                    <img data-photo-id="${p.id}" class="lazy-prod-photo" alt="${prodName}" loading="lazy" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3C/svg%3E">
                </div>`;
    } else {
      const initial = prodName[0].toUpperCase();
      imageHtml = `<div class="product-img-container placeholder ${catClass}">
                    <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
                        <span style="font-size:2rem;">${getCategoryIcon(prodCat)}</span>
                        <span style="font-size:1.1rem;font-weight:700;opacity:0.8;">${initial}</span>
                    </div>
                    <button onclick="event.stopPropagation();quickUploadPhoto(${p.id})" 
                        style="position:absolute;bottom:6px;right:6px;background:rgba(0,0,0,0.6);border:none;color:white;padding:4px 8px;border-radius:6px;font-size:0.7rem;cursor:pointer;backdrop-filter:blur(4px);">
                        <i class="fa-solid fa-camera"></i> Add Photo
                    </button>
                </div>`;
    }

    card.innerHTML = `
            ${imageHtml}
            <div class="product-info">
                <h4>${prodName}</h4>
                <div class="price">UGX ${prodPrice.toLocaleString()}</div>
                <div class="stock" style="display:flex;justify-content:space-between;align-items:center;">
                    <span>${isUnlimited ? '<span style="color:#8B5CF6; font-weight:700;"><i class="fa-solid fa-infinity"></i> Unlimited</span>' : (prodStock > 0 ? "In Stock: " + prodStock : "\u26a0\ufe0f Out of Stock")}</span>
                    ${p.barcode ? `<span style="font-size:0.6rem;background:rgba(99,102,241,0.15);color:var(--primary);padding:2px 6px;border-radius:4px;">#${p.barcode}</span>` : ""}
                </div>
            </div>
        `;
    if (isUnlimited || prodStock > 0) card.onclick = () => addToCart(p);
    grid.appendChild(card);
  });

  lazyLoadProductImages();
  // Run active inventory filter
  if (typeof window.filterInventory === "function") window.filterInventory();
}

// Quick photo upload from POS tiles
function quickUploadPhoto(productId) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.capture = "environment"; // Opens camera on mobile
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      alert("Image too large (max 5MB)");
      return;
    }
    const base64 = await new Promise((r) => {
      const reader = new FileReader();
      reader.onload = (ev) => r(ev.target.result);
      reader.readAsDataURL(file);
    });
    try {
      const res = await fetchAuth(`${API_URL}/products/${productId}/photo`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo_base64: base64 }),
      });
      if (res.ok) {
        showToast(`Photo uploaded!`, "success");
        loadPOSProducts();
        loadInventory();
      } else {
        alert("Failed to upload photo");
      }
    } catch (err) {
      alert("Upload error: " + err.message);
    }
  };
  input.click();
}

let cachedProducts = []; // Needed for instant barcode lookup
async function handleBarcodeScan(code) {
  // Always fetch fresh products to ensure additional_barcodes (from product_barcodes table) are included
  try {
    if (window.OfflineDB && typeof window.OfflineDB.bustCache === "function") {
      await window.OfflineDB.bustCache("/api/products").catch(() => {});
    }
    const res = await fetchAuth(`${API_URL}/products?force_refresh=true&_t=${Date.now()}`);
    const data = await res.json();
    if (data.products) cachedProducts = data.products;
  } catch (e) {
    // If fetch fails, fall back to cached
    if (!cachedProducts.length) return null;
  }

  // Tightest-match: find the product with the smallest range containing this code
  let bestMatch = null;
  let bestRangeSize = Infinity;

  for (const p of cachedProducts) {
    if (String(p.barcode) === String(code) || String(p.id) === String(code)) {
      bestMatch = p;
      break; // Exact match is definitive
    }
    if (
      p.additional_barcodes &&
      p.additional_barcodes.some((b) => String(b) === String(code))
    ) {
      bestMatch = p;
      break; // Exact match on custom barcodes is definitive
    }
    if (p.barcode_end && !isNaN(code)) {
      const scanNum = parseInt(code);
      const startNum = parseInt(p.barcode);
      const endNum = parseInt(p.barcode_end);
      if (
        !isNaN(startNum) &&
        !isNaN(endNum) &&
        scanNum >= startNum &&
        scanNum <= endNum
      ) {
        const rangeSize = endNum - startNum;
        if (rangeSize < bestRangeSize) {
          bestMatch = p;
          bestRangeSize = rangeSize;
        }
      }
    }
  }

  // VALIDATE UNIQUE BARCODE
  if (bestMatch && !isNaN(code)) {
    if (soldBarcodes.has(code)) {
      showToast(`Barcode ${code} already sold and recorded!`, "danger");
      return null;
    }
    // Check if already in current cart
    const inCart = posCart.some(
      (item) => item.barcodes && item.barcodes.includes(code),
    );
    if (inCart) {
      showToast(`Barcode ${code} already in cart`, "warning");
      return null;
    }
  }

  if (bestMatch) {
    if (bestMatch.stock > 0) {
      addToCart(bestMatch, code);
      showToast(`${bestMatch.name} identified`, "success");
    } else {
      showToast(`Out of stock: ${bestMatch.name}`, "danger");
    }
    return bestMatch;
  } else {
    if (code.length > 3) {
      showToast(`Barcode ${code} not found in inventory`, "warning");
    }
    return null;
  }
}

// ==== CAMERA PRODUCT SCANNER ====
let productScanner = null;

async function stopProductScanner() {
  if (productScanner) {
    await productScanner.stop();
  }
  document.getElementById("product-scanner-modal").classList.add("hidden");
}

window.ensureCashierShiftActive = async function (actionName = "proceed") {
  const _role = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
  // Non-cashier roles (waiter, admin, manager, etc.) NEVER need a cashier shift
  if (_role !== "CASHIER") return true;

  if (window._hasActiveCashierShift === true) return true;

  try {
    const res = await fetchAuth(`${API_URL}/pos/current-shift`);
    if (res.ok) {
      const data = await res.json();
      window._hasActiveCashierShift = !!(data.has_active_shift && data.shift);
      window._activeCashierShiftData = data.shift || null;
      if (window._hasActiveCashierShift) {
        try { localStorage.setItem("jomish_active_shift", "true"); } catch (_) {}
        return true;
      }
    }
  } catch (_) {}

  showToast(`Please tap "Start Shift" before you can ${actionName}.`, "warning");
  if (typeof openStartShiftModal === "function") {
    openStartShiftModal();
  }
  return false;
};

function addToCart(p, scannedBarcode = null) {
  const _role = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
  if (_role === "CASHIER" && !window._hasActiveCashierShift) {
    window.ensureCashierShiftActive("add items to cart").then((active) => {
      if (active) addToCart(p, scannedBarcode);
    });
    return;
  }
  const existing = posCart.find((i) => i.id === p.id);
  
  // Calculate what the stock will be after adding 1 more to the cart
  const currentQtyInCart = existing ? existing.qty : 0;
  const remainingAfterAdd = p.stock - currentQtyInCart - 1;
  const isTracked = p.track_stock !== 0;
  
  // Check if remaining stock is hitting the warning threshold
  if (isTracked && remainingAfterAdd <= 10 && remainingAfterAdd >= 0) {
    showToast(`Low Inventory Warning: Only ${remainingAfterAdd} remaining for ${p.name}`, "warning");
  }

  if (existing) {
    if (!isTracked || existing.qty < p.stock) {
      existing.qty += 1;
      if (scannedBarcode && !isNaN(scannedBarcode)) {
        if (!existing.barcodes) existing.barcodes = [];
        existing.barcodes.push(scannedBarcode);
      }
    } else {
      showToast(`Cannot add ${p.name}. Out of stock!`, "error");
    }
  } else {
    if (!isTracked || p.stock > 0) {
      const item = { ...p, qty: 1 };
      if (scannedBarcode && !isNaN(scannedBarcode)) {
        item.barcodes = [scannedBarcode];
      } else {
        item.barcodes = [];
      }
      posCart.push(item);
    } else {
      showToast(`Cannot add ${p.name}. Out of stock!`, "error");
    }
  }
  renderCart();
}

function updateCartQty(id, delta) {
  const item = posCart.find((i) => i.id === id);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) {
    removeFromCart(id);
    return;
  }
  renderCart();
}

window.removeFromCart = function (id) {
  if (posCart.length <= 1) {
    showToast("An order must have at least one item. If you wish to cancel this order, tap Cancel.", "warning");
    return;
  }
  const item = posCart.find((i) => i.id === id);
  const name = item ? item.name : "Item";
  posCart = posCart.filter((i) => i.id !== id);
  showToast(`Removed "${name}" from order`, "info");
  renderCart();
};

function setCartQty(id, val) {
  const qty = parseInt(val);
  if (isNaN(qty) || qty <= 0) {
    removeFromCart(id);
  } else {
    const item = posCart.find((i) => i.id === id);
    if (item) item.qty = qty;
    renderCart();
  }
}

function renderCart() {
  window.posCart = posCart; // keep window reference in sync
  const container = document.getElementById("cart-items");
  container.innerHTML = "";
  let subtotal = 0;
  posCart.forEach((item) => {
    subtotal += item.price * item.qty;
    const el = document.createElement("div");
    el.className = "cart-item";
    const thumbHtml =
      item.photo_base64 && item.photo_base64.length > 50
        ? `<img src="${item.photo_base64}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;border:1px solid var(--border);">`
        : `<div style="width:36px;height:36px;border-radius:6px;background:var(--background);display:flex;align-items:center;justify-content:center;font-size:1rem;border:1px solid var(--border);">${getCategoryIcon(item.category)}</div>`;
    el.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;">
                ${thumbHtml}
                <div class="cart-item-info"><strong>${item.name}</strong><span>UGX ${item.price.toFixed(0)}</span></div>
            </div>
            <div class="cart-item-controls">
                <button class="qty-btn" onclick="updateCartQty(${item.id}, -1)">-</button>
                <input type="number" min="1" value="${item.qty}" 
                    style="width:48px; text-align:center; background:var(--background); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:0.95rem; font-weight:700; padding:4px 0;"
                    onchange="setCartQty(${item.id}, this.value)"
                    oninput="setCartQty(${item.id}, this.value)">
                <button class="qty-btn" onclick="updateCartQty(${item.id}, 1)">+</button>
                <button class="qty-btn" onclick="removeFromCart(${item.id})" title="Remove item" style="color:var(--danger, #EF4444); border-color:rgba(239, 68, 68, 0.35); margin-left:4px;"><i class="fa-solid fa-trash-can"></i></button>
            </div>`;
    container.appendChild(el);
  });
  const tax = subtotal * TAX_RATE;
  const total = subtotal + tax;
  document.getElementById("cart-subtotal").textContent =
    `UGX ${subtotal.toFixed(0)}`;
  document.getElementById("cart-tax").textContent = `UGX ${tax.toFixed(0)}`;
  document.getElementById("cart-total").textContent = `UGX ${total.toFixed(0)}`;
  document
    .getElementById("btn-checkout")
    .setAttribute("data-total", total.toFixed(0));

  // Re-enable Print Invoice button when cart has items (new order started or edit loaded)
  // Disable/grey it when cart is empty so it can't be double-tapped after printing
  const _btnPI = document.getElementById("btn-print-invoice");
  if (_btnPI && !_currentEditOrder) {
    if (posCart.length > 0) {
      _btnPI.disabled = false;
      _btnPI.style.opacity = "";
      _btnPI.style.pointerEvents = "";
      _btnPI.innerHTML = '<i class="fa-solid fa-print"></i> PRINT INVOICE';
    } else {
      _btnPI.disabled = true;
      _btnPI.style.opacity = "0.45";
      _btnPI.style.pointerEvents = "none";
      _btnPI.innerHTML = '<i class="fa-solid fa-print"></i> PRINT INVOICE';
    }
  }
}

// ==== CASH PAYMENT NUMPAD ENGINE ====

function numpadPress(key) {
  const input = document.getElementById("pay-amount");
  // Strip any non-digit chars in case user typed directly
  let val = String(input.value || "0").replace(/[^0-9]/g, "") || "0";

  if (key === "C") {
    val = "0";
  } else if (key === "\u232b" || key === "?") {
    val = val.length > 1 ? val.slice(0, -1) : "0";
  } else {
    val = val === "0" ? key : val + key;
  }

  // Cap at 12 digits
  if (val.length > 12) return;
  input.value = val;
  updateChange();
}

function numpadExact() {
  const total =
    parseFloat(
      document.getElementById("btn-checkout").getAttribute("data-total"),
    ) || 0;
  document.getElementById("pay-amount").value = Math.round(total).toString();
  updateChange();
  
  // Exact cash = no change needed — confirm immediately
  const btnConfirm = document.getElementById("btn-confirm-pay");
  if (btnConfirm && btnConfirm.hasAttribute("data-pending-id")) {
    const pendingId = btnConfirm.getAttribute("data-pending-id");
    collectPendingPayment(pendingId, total);
  } else {
    confirmPayment();
  }
}

function updateChange() {
  const method = document.getElementById("payment-method-select")?.value;
  const total =
    parseFloat(
      document.getElementById("btn-checkout").getAttribute("data-total"),
    ) || 0;
  const paid = parseInt(document.getElementById("pay-amount").value) || 0;
  const changeEl = document.getElementById("pay-change");

  if (method === "DISCOUNT") {
    const diff = Math.round(total) - paid;
    if (diff > 0) {
      changeEl.textContent = "Discount: UGX " + diff.toLocaleString();
      changeEl.style.color = "#10B981"; // green
    } else {
      changeEl.textContent = "UGX 0 (Custom Price)";
      changeEl.style.color = "var(--text-muted)";
    }
    return;
  }

  if (method === "CREDIT") {
    const diff = Math.round(total) - paid;
    if (paid > Math.round(total)) {
      changeEl.textContent = "Deposit cannot exceed Total!";
      changeEl.style.color = "#EF4444";
    } else if (paid === 0 || diff === Math.round(total)) {
      changeEl.textContent = "Full Credit: UGX " + Math.round(total).toLocaleString();
      changeEl.style.color = "#F59E0B";
    } else {
      changeEl.textContent = `Deposit: UGX ${paid.toLocaleString()} | Due: UGX ${diff.toLocaleString()}`;
      changeEl.style.color = "#F59E0B";
    }
    return;
  }

  const change = paid - Math.round(total);
  if (change >= 0) {
    changeEl.textContent = "UGX " + change.toLocaleString();
    changeEl.style.color = "#10B981"; // green
  } else {
    changeEl.textContent = "-UGX " + Math.abs(change).toLocaleString();
    changeEl.style.color = "#EF4444"; // red = not enough
  }
}

function generateClientUUID(prefix = "pos") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch (_) {}
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function closePaymentPanel() {
  const panel = document.getElementById("payment-panel");
  if (panel) panel.classList.add("hidden");
  const servedByContainer = document.getElementById("pay-served-by-container");
  if (servedByContainer) servedByContainer.style.display = "none";
  window._pendingServedBy = null;

  // Reset confirm button back to default checkout if it was tied to a pending order
  const btnConfirm = document.getElementById("btn-confirm-pay");
  if (btnConfirm) {
    btnConfirm.removeAttribute("data-pending-id");
    btnConfirm.disabled = false;
    btnConfirm.onclick = () => confirmPayment();
    btnConfirm.innerHTML = '<i class="fa-solid fa-check"></i> CONFIRM PAYMENT';
  }
  window._pendingOrderId = null;
  window._pendingOrderTotal = null;

  // CRITICAL: Force-reset payment lock flags so cancel always unblocks immediately.
  // Without this, tapping Cancel while a payment is in-flight leaves the flags
  // stuck at true, making the panel appear broken until the async call finishes.
  _isConfirmingPayment = false;
  _isCollectingPending = false;

  // Always reset payment method back to Cash when payment panel closes
  const payMethodSelect = document.getElementById("payment-method-select");
  if (payMethodSelect) {
    payMethodSelect.value = "CASH";
    if (typeof handlePaymentMethodChange === "function") {
      handlePaymentMethodChange();
    }
  }
}

window.handleDeliveryCheckboxChange = function () {
  const isDelivery = document.getElementById("send-to-transport-chk")?.checked || false;
  const deliveryContainer = document.getElementById("delivery-info-container");
  const btnConfirmPay = document.getElementById("btn-confirm-pay");

  if (isDelivery) {
    if (deliveryContainer) deliveryContainer.style.display = "block";
    if (btnConfirmPay) {
      btnConfirmPay.innerHTML = '<i class="fa-solid fa-truck"></i> CONFIRM & DISPATCH';
    }
  } else {
    if (deliveryContainer) deliveryContainer.style.display = "none";
    if (btnConfirmPay) {
      btnConfirmPay.innerHTML = '<i class="fa-solid fa-check"></i> CONFIRM PAYMENT';
    }
  }
};

window.updateSplitBalance = function () {
  const btnCheckout = document.getElementById("btn-checkout");
  const total = parseFloat(
    btnCheckout?.getAttribute("data-total") || window._pendingOrderTotal || "0"
  ) || 0;
  const cashInput = document.getElementById("split-cash-amount");
  const secSelect = document.getElementById("split-second-method");
  const balEl = document.getElementById("split-remaining-balance");
  const buyerContainer = document.getElementById("buyer-name-container");

  const cashVal = parseFloat(cashInput?.value) || 0;
  const remaining = Math.max(0, total - cashVal);

  if (balEl) {
    balEl.textContent = `UGX ${Math.round(remaining).toLocaleString()}`;
  }

  const payInput = document.getElementById("pay-amount");
  if (payInput) {
    payInput.value = total;
  }
  if (typeof updateChange === "function") updateChange();

  const secMethod = secSelect ? secSelect.value : "MOBILE MONEY";
  if (secMethod === "CREDIT") {
    if (buyerContainer) buyerContainer.style.display = "block";
  } else {
    const deliveryChk = document.getElementById("send-to-transport-chk");
    if (!deliveryChk || !deliveryChk.checked) {
      if (buyerContainer) buyerContainer.style.display = "none";
    }
  }
};

window.handlePaymentMethodChange = async function () {
  const methodSelect = document.getElementById("payment-method-select");
  if (!methodSelect) return;
  const method = methodSelect.value;
  const buyerContainer = document.getElementById("buyer-name-container");
  const payAmountInput = document.getElementById("pay-amount");
  const deliveryChk = document.getElementById("send-to-transport-chk");
  const splitContainer = document.getElementById("split-payment-container");

  if (method === "SPLIT") {
    if (splitContainer) splitContainer.style.display = "block";
    if (payAmountInput) payAmountInput.removeAttribute("readonly");
    const payLabel = document.getElementById("pay-amount-label") || (payAmountInput ? payAmountInput.previousElementSibling : null);
    if (payLabel) payLabel.textContent = "Total Amount Due (UGX)";
    if (typeof window.updateSplitBalance === "function") {
      window.updateSplitBalance();
    }
  } else {
    if (splitContainer) splitContainer.style.display = "none";
  }

  if (method === "COD") {
    if (deliveryChk) {
      deliveryChk.checked = true;
      if (typeof window.handleDeliveryCheckboxChange === "function") {
        window.handleDeliveryCheckboxChange();
      }
    }
    if (payAmountInput) {
      payAmountInput.value = "0";
      payAmountInput.setAttribute("readonly", "true");
    }
    if (buyerContainer) buyerContainer.style.display = "none";
  } else if (method === "DISCOUNT") {
    if (payAmountInput) payAmountInput.removeAttribute("readonly");
    if (buyerContainer) buyerContainer.style.display = "none";
    if (typeof updateChange === "function") updateChange();
    if (payAmountInput) {
      payAmountInput.focus();
      payAmountInput.select();
    }
  } else if (method === "CREDIT") {
    if (payAmountInput) {
      payAmountInput.removeAttribute("readonly");
      payAmountInput.value = "0"; // default to 0 deposit for full credit
    }
    if (buyerContainer) buyerContainer.style.display = "block";
    const payLabel = document.getElementById("pay-amount-label") || (payAmountInput ? payAmountInput.previousElementSibling : null);
    if (payLabel) payLabel.textContent = "Deposit Paid Now (UGX) — Leave 0 for Full Credit";
    if (typeof updateChange === "function") updateChange();
    const buyerInput = document.getElementById("buyer-name-input");
    if (buyerInput) buyerInput.focus();
  } else {
    if (payAmountInput) payAmountInput.removeAttribute("readonly");
    const payLabel = document.getElementById("pay-amount-label") || (payAmountInput ? payAmountInput.previousElementSibling : null);
    if (payLabel) payLabel.textContent = "Amount Paid";
    if (buyerContainer) buyerContainer.style.display = "none";
    if (typeof updateChange === "function") updateChange();
  }

  if (method === "CREDIT" || method === "COD") {
    try {
      const res = await fetchAuth(`${API_URL}/buyers`);
      if (res.ok) {
        const data = await res.json();
        const datalist = document.getElementById("buyer-names-list");
        if (datalist && Array.isArray(data.buyers)) {
          datalist.innerHTML = "";
          data.buyers.forEach((buyer) => {
            const option = document.createElement("option");
            option.value = buyer;
            datalist.appendChild(option);
          });
        }
      }
    } catch (e) {
      console.error("Failed to load buyers list:", e);
    }
  }
};

let _isConfirmingPayment = false;

async function confirmPayment() {
  if (_isConfirmingPayment) {
    console.warn("Payment submission already in progress.");
    return;
  }
  // Block: only Cashier role can collect direct payment
  const _roleNow = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
  if (_roleNow !== "CASHIER") {
    alert("Only a Cashier can collect direct payment. Use 'PRINT INVOICE' instead.");
    return;
  }
  const hasActiveShift = await window.ensureCashierShiftActive("process payments");
  if (!hasActiveShift) return;
  // Block: if we are in edit-order mode, save the edit instead of creating a new order
  if (_currentEditOrder && _currentEditOrder.id) {
    alert('You are editing an existing order. Use "Save Changes" to update it, or "Cancel" to exit edit mode.');
    return;
  }
  if (!posCart || posCart.length === 0) {
    alert("Cart is empty!");
    return;
  }
  const total =
    parseFloat(
      document.getElementById("btn-checkout")?.getAttribute("data-total") || "0",
    ) || 0;
  const payInput = document.getElementById("pay-amount");
  const paid = payInput ? (parseInt(payInput.value) || 0) : 0;
  const paymentMethodSelect = document.getElementById("payment-method-select");
  const paymentMethod = paymentMethodSelect ? paymentMethodSelect.value : "CASH";
  const buyerName = document.getElementById("buyer-name-input")?.value?.trim() || "";
  const buyerPhone = document.getElementById("buyer-phone-input")?.value?.trim() || "";
  const isDelivery = document.getElementById("send-to-transport-chk")?.checked || false;
  const deliveryAddress = document.getElementById("delivery-address-input")?.value?.trim() || "";

  let splitCash = 0;
  let splitSec = 0;
  let splitSecMethod = "MOBILE MONEY";

  if (paymentMethod === "SPLIT") {
    splitCash = parseFloat(document.getElementById("split-cash-amount")?.value) || 0;
    if (splitCash < 0) {
      alert("Cash amount cannot be negative!");
      return;
    }
    if (splitCash > Math.round(total)) {
      alert(`Cash amount (UGX ${splitCash.toLocaleString()}) cannot exceed total due (UGX ${Math.round(total).toLocaleString()})!`);
      return;
    }
    splitSec = Math.max(0, Math.round(total) - splitCash);
    splitSecMethod = document.getElementById("split-second-method")?.value || "MOBILE MONEY";
    if (splitSecMethod === "CREDIT" && !buyerName) {
      alert("Please enter Customer / Buyer Name for the remaining Credit balance.");
      return;
    }
  } else if (paymentMethod === "CREDIT") {
    if (paid > Math.round(total)) {
      alert("For credit, amount paid cannot exceed the total amount.");
      return;
    }
    if (!buyerName) {
      alert("Please enter a Buyer Name for Credit transactions.");
      return;
    }
  } else if (paymentMethod === "DISCOUNT") {
    // Discount as form of payment: whatever amount the cashier inserts is what is paid for those products no matter the real price
  } else if (paymentMethod !== "COD") {
    if (paid < Math.round(total)) {
      alert(
        "Amount paid is less than total! Customer still owes UGX " +
          (Math.round(total) - paid).toLocaleString(),
      );
      return;
    }
  }

  if (isDelivery && !deliveryAddress) {
    alert("Please enter a delivery location/address.");
    return;
  }

  const effectiveTotal = paymentMethod === "DISCOUNT" ? paid : total;
  const change = paymentMethod !== "DISCOUNT" && paid > Math.round(total) ? paid - Math.round(total) : 0;

  const btnConfirm = document.getElementById("btn-confirm-pay");
  const origBtnHtml = btnConfirm ? btnConfirm.innerHTML : "";
  _isConfirmingPayment = true;
  if (btnConfirm) {
    btnConfirm.disabled = true;
    btnConfirm.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
  }

  const client_uuid = generateClientUUID("pos");

  const effectivePaid = paymentMethod === "CREDIT" && paid >= Math.round(total) ? 0 : paid;

  try {
    const res = await fetchAuth(`${API_URL}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_uuid: client_uuid,
        total_amount: effectiveTotal,
        original_total: total,
        items: posCart,
        payment_method: paymentMethod,
        amount_paid: effectivePaid,
        buyer_name: buyerName,
        buyer_phone: buyerPhone,
        is_delivery: isDelivery,
        delivery_address: deliveryAddress,
        split_cash_amount: splitCash,
        split_second_amount: splitSec,
        split_second_method: splitSecMethod,
      }),
    });
    if (res.ok) {
      const result = await res.json();
      closePaymentPanel();

      // Reset payment method dropdown back to Cash after order is finished
      const pmSelect = document.getElementById("payment-method-select");
      if (pmSelect) {
        pmSelect.value = "CASH";
        if (typeof handlePaymentMethodChange === "function") handlePaymentMethodChange();
      }

      // Scroll main-content back to top so tab bar (Register/Inventory/etc.) is not hidden
      const mainContent = document.querySelector(".main-content");
      if (mainContent) mainContent.scrollTop = 0;

      if (change > 0) {
        showToast(`Give change: UGX ${change.toLocaleString()}`, "success");
      }

      // Record used barcodes in local cache
      posCart.forEach((item) => {
        if (item.barcodes) {
          item.barcodes.forEach((bc) => soldBarcodes.add(bc));
        }
      });

      const methodLabel = paymentMethod === "SPLIT"
        ? `SPLIT (Cash: UGX ${splitCash.toLocaleString()} + ${splitSecMethod}: UGX ${splitSec.toLocaleString()})`
        : paymentMethod;

      printReceipt(
        posCart,
        effectiveTotal,
        result.receipt_no || result.transaction_id,
        methodLabel,
        paid,
        buyerName,
        null,
        false,
        null,
        paymentMethod === "DISCOUNT" ? total : null,
      );

      posCart = [];
      renderCart();
      loadPOSProducts();
      loadDashboard();
      loadTransactions();
      if (paymentMethod === "CREDIT" && typeof loadCredits === "function") {
        loadCredits();
      }
      const smeProdView = document.getElementById("sme-view-products");
      if (smeProdView && smeProdView.style.display !== "none" && typeof loadSmeProductSales === "function") {
        loadSmeProductSales();
      }
      const invSection = document.getElementById("inventory");
      if (invSection && invSection.classList.contains("active") && typeof loadInventory === "function") {
        loadInventory();
      }
    } else {
      const data = await res.json();
      alert("Error: " + data.error);
    }
  } catch (e) {
    if (
      !navigator.onLine ||
      e.message.toLowerCase().includes("failed to fetch")
    ) {
      const offlinePayload = {
        total_amount: effectiveTotal,
        items: posCart,
        payment_method: paymentMethod,
        amount_paid: paid,
        buyer_name: buyerName,
        buyer_phone: buyerPhone,
      };
      if (window.OfflineDB) {
        await window.OfflineDB.queueOfflineSale(client_uuid, offlinePayload);
      }
      closePaymentPanel();

      // Reset payment method dropdown back to Cash
      const pmSelect = document.getElementById("payment-method-select");
      if (pmSelect) {
        pmSelect.value = "CASH";
        if (typeof handlePaymentMethodChange === "function") handlePaymentMethodChange();
      }

      const mainContent = document.querySelector(".main-content");
      if (mainContent) mainContent.scrollTop = 0;

      if (change > 0) {
        showToast(`Give change: UGX ${change.toLocaleString()}`, "success");
      }

      posCart.forEach((item) => {
        if (item.barcodes) {
          item.barcodes.forEach((bc) => soldBarcodes.add(bc));
        }
      });

      printReceipt(
        posCart,
        effectiveTotal,
        `OFFLINE-${client_uuid.slice(0, 8).toUpperCase()}`,
        paymentMethod,
        paid,
        buyerName,
        null,
        false,
        null,
        paymentMethod === "DISCOUNT" ? total : null,
      );

      posCart = [];
      renderCart();
      updateSyncBadge();
      showToast(
        "📶 Offline — sale saved locally. Will sync when reconnected.",
        "warning",
      );
      return;
    }
    console.error("Payment confirmation error:", e);
    alert("Checkout failed: " + e.message);
  } finally {
    _isConfirmingPayment = false;
    if (btnConfirm) {
      btnConfirm.disabled = false;
      btnConfirm.innerHTML = origBtnHtml || '<i class="fa-solid fa-check"></i> CONFIRM PAYMENT';
    }
  }
}

// ── WAITER ORDER SUBMISSION ────────────────────────────────────────────────
// Waiter places a pending order (COD) — prints invoice/token, sends order to pending queue.
// The Cashier will see it in the Pending tab with 'Served by: [1st name]' and collect payment later.
let _isSubmittingWaiterOrder = false;
async function submitWaiterOrder() {
  if (_isSubmittingWaiterOrder) return;
  if (posCart.length === 0) return alert("Cart is empty!");

  const _roleNow = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
  if (_roleNow === "CASHIER" && !window._hasActiveCashierShift) {
    const hasShift = await window.ensureCashierShiftActive("add or submit orders");
    if (!hasShift) return;
  }

  if (_currentEditOrder && _currentEditOrder.id) {
    _isSubmittingWaiterOrder = true;
    // Target whichever button is visible — cashier sees btn-print-invoice, waiter sees btn-send-to-cashier
    const btnWaiter = document.getElementById("btn-print-invoice") || document.getElementById("btn-send-to-cashier");
    const origHtml = btnWaiter ? btnWaiter.innerHTML : "";
    if (btnWaiter) {
      btnWaiter.disabled = true;
      btnWaiter.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Updating...';
    }
    try {
      const items = posCart.map((i) => ({
        id: i.product_id || i.id,
        product_id: i.product_id || i.id,
        name: i.name,
        price: i.price,
        qty: i.qty || 1,
      }));

      const res = await fetchAuth(`${API_URL}/pos_orders/${_currentEditOrder.id}/items`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to update order");
      }

      const rawName = USER_NAME || localStorage.getItem("jomish_name") || "Staff";
      const staffFirstName = rawName.trim().split(/\s+/)[0] || "Staff";
      const rawOrderNo = _currentEditOrder.invoice_number || _currentEditOrder.id;
      const invLabel = formatDocNo("INV", rawOrderNo);

      showToast(`Order ${invLabel} updated!`, "success");

      // Print updated kitchen token for the SAME existing order
      const dateStr = new Date().toLocaleString("en-UG", { timeZone: "Africa/Kampala" });
      const tokenData = {
        isInvoice: false,
        printTokenOnly: true,
        isEdited: true,
        orderId: invLabel,
        dateStr,
        cashierName: staffFirstName,
        servedBy: _currentEditOrder.served_by || staffFirstName,
        items: posCart.map((i) => {
          const itemId = i.id || i.product_id;
          const orig = _editOrderOriginalQtys && _editOrderOriginalQtys[itemId];
          const origQty = orig !== undefined ? Number(orig) : 0;
          const currentQty = Number(i.qty) || 1;
          const addedQty = Math.max(0, currentQty - origQty);
          return {
            name: i.name,
            qty: currentQty,
            price: i.price,
            origQty,
            addedQty,
            isNew: origQty === 0,
          };
        }),
      };
      _printHTMLQueue([_buildKitchenTokenHTML(tokenData)]);

      // Clean up edit mode
      const banner = document.getElementById("edit-order-banner");
      if (banner) banner.remove();
      _currentEditOrder = null;
      _editOrderOriginalQtys = {};
      posCart = [];
      renderCart();
      loadPOSProducts();

      const buyerNameEl = document.getElementById("buyer-name-input");
      const buyerPhoneEl = document.getElementById("buyer-phone-input");
      if (buyerNameEl) buyerNameEl.value = "";
      if (buyerPhoneEl) buyerPhoneEl.value = "";

      switchPOSView("pending");
      if (typeof loadPendingCOD === "function") loadPendingCOD(true); // force=true: bypass cache after edit
    } catch (e) {
      alert("Error updating order: " + e.message);
    } finally {
      if (btnWaiter) {
        btnWaiter.disabled = false;
        btnWaiter.innerHTML = origHtml || '<i class="fa-solid fa-print"></i> PRINT INVOICE';
      }
      _isSubmittingWaiterOrder = false;
    }
    return;
  }
  _isSubmittingWaiterOrder = true;

  const total =
    parseFloat(document.getElementById("btn-checkout")?.getAttribute("data-total")) ||
    posCart.reduce((sum, item) => sum + (item.price * (item.qty || 1)), 0);
  const buyerNameEl = document.getElementById("buyer-name-input");
  const buyerPhoneEl = document.getElementById("buyer-phone-input");
  const buyerName = buyerNameEl ? buyerNameEl.value.trim() : "";
  const buyerPhone = buyerPhoneEl ? buyerPhoneEl.value.trim() : "";

  // Extract waiter's 1st name
  const rawName = USER_NAME || localStorage.getItem("jomish_name") || "Waiter";
  const waiterFirstName = rawName.trim().split(/\s+/)[0] || "Waiter";

  // The waiter sees btn-send-to-cashier (now labelled "PRINT INVOICE")
  const btnWaiter = document.getElementById("btn-send-to-cashier") || document.getElementById("btn-print-invoice");
  const origHtml = btnWaiter ? btnWaiter.innerHTML : "";
  if (btnWaiter) {
    btnWaiter.disabled = true;
    btnWaiter.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Printing...';
  }

  try {
    const res = await fetchAuth(`${API_URL}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_uuid: generateClientUUID("waiter"),
        total_amount: total,
        items: posCart,
        payment_method: "COD",
        amount_paid: 0,
        buyer_name: buyerName || "Walk-in",
        buyer_phone: buyerPhone,
        is_delivery: false,
        delivery_address: "",
        served_by: waiterFirstName,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      // Use invoice_number as the single consistent order number across all prints
      const rawOrderNo = data.invoice_number || data.pos_order_id || data.receipt_no || data.transaction_id || "";
      const invLabel = formatDocNo("INV", rawOrderNo);
      showToast(`Order ${invLabel} sent to kitchen — Served by ${waiterFirstName}`, "success");

      // Print ONLY the kitchen token for waiter
      const dateStr = new Date().toLocaleString("en-UG", { timeZone: "Africa/Kampala" });
      const tokenData = {
        isInvoice: false,
        printTokenOnly: true,
        orderId: invLabel,
        dateStr,
        cashierName: waiterFirstName,
        servedBy: waiterFirstName,
        items: posCart.map((i) => ({ name: i.name, qty: i.qty || 1, price: i.price })),
      };
      _printHTMLQueue([_buildKitchenTokenHTML(tokenData)]);

      posCart = [];
      renderCart();
      loadPOSProducts();
      if (buyerNameEl) buyerNameEl.value = "";
      if (buyerPhoneEl) buyerPhoneEl.value = "";

      if (btnWaiter) {
        btnWaiter.style.opacity = "0.4";
        btnWaiter.style.pointerEvents = "none";
        btnWaiter.innerHTML = '<i class="fa-solid fa-check"></i> Printed';
        setTimeout(() => {
          btnWaiter.disabled = false;
          btnWaiter.style.opacity = "1";
          btnWaiter.style.pointerEvents = "auto";
          btnWaiter.innerHTML = origHtml || '<i class="fa-solid fa-print"></i> PRINT INVOICE';
        }, 3500);
      }
    } else {
      const data = await res.json();
      alert("Error: " + data.error);
      if (btnWaiter) {
        btnWaiter.disabled = false;
        btnWaiter.innerHTML = origHtml;
      }
    }
  } catch (e) {
    // If we're offline or the network failed, queue the order so it isn't lost
    const isNetworkError = !navigator.onLine || e.message.toLowerCase().includes("failed to fetch") || e.message.toLowerCase().includes("network");
    if (isNetworkError && window.OfflineDB) {
      try {
        const offlinePayload = {
          client_uuid: generateClientUUID("waiter"),
          total_amount: posCart.reduce((sum, item) => sum + (item.price * (item.qty || 1)), 0),
          items: posCart,
          payment_method: "COD",
          amount_paid: 0,
          buyer_name: document.getElementById("buyer-name-input")?.value?.trim() || "Walk-in",
          buyer_phone: document.getElementById("buyer-phone-input")?.value?.trim() || "",
          is_delivery: false,
          delivery_address: "",
          served_by: (USER_NAME || localStorage.getItem("jomish_name") || "Waiter").trim().split(/\s+/)[0] || "Waiter",
        };
        await window.OfflineDB.queueMutation(`${API_URL}/checkout`, "POST", {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(offlinePayload),
        });
        showToast("Offline: Order saved locally and will sync when online.", "warning");
        posCart = [];
        renderCart();
        loadPOSProducts();
      } catch (queueErr) {
        console.error("[submitWaiterOrder] Failed to queue offline order:", queueErr);
        alert("Failed to submit order (offline) and could not queue it: " + queueErr.message);
      }
    } else {
      alert("Failed to submit order: " + e.message);
    }
    if (btnWaiter) {
      btnWaiter.disabled = false;
      btnWaiter.innerHTML = origHtml;
    }
  } finally {
    setTimeout(() => {
      _isSubmittingWaiterOrder = false;
    }, 2000);
  }
}
window.submitWaiterOrder = submitWaiterOrder;

let _isGettingInvoice = false;
async function getInvoice() {
  if (_isGettingInvoice) return;
  if (_currentEditOrder && _currentEditOrder.id) {
    if (typeof printEditOrderKitchenToken === "function") {
      printEditOrderKitchenToken();
    }
    return;
  }
  const _role = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
  if (_role === "WAITER") {
    // Waiters should never print invoices/orders — send directly to cashier instead
    return submitWaiterOrder();
  }
  if (posCart.length === 0) return alert("Cart is empty!");
  const total =
    parseFloat(
      document.getElementById("btn-checkout")?.getAttribute("data-total") || "0",
    ) || posCart.reduce((sum, item) => sum + (item.price * (item.qty || 1)), 0);
  const buyerName = document.getElementById("buyer-name-input")?.value?.trim() || "Walk-in Customer";
  const buyerPhone = document.getElementById("buyer-phone-input")?.value?.trim() || "";
  // Saving an invoice means NO delivery dispatch yet. It just records the unpaid sale.
  // If they want to dispatch COD, they must use the standard checkout flow with COD selected.
  const isDelivery = false;
  const deliveryAddress = "";

  const client_uuid = generateClientUUID("inv");
  const _btnPI = document.getElementById("btn-print-invoice");
  const origPIHtml = _btnPI ? _btnPI.innerHTML : "";
  _isGettingInvoice = true;
  if (_btnPI) {
    _btnPI.disabled = true;
    _btnPI.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
  }

  try {
    const res = await fetchAuth(`${API_URL}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_uuid,
        total_amount: total,
        items: posCart,
        payment_method: "INVOICE",
        amount_paid: 0,
        buyer_name: buyerName,
        buyer_phone: buyerPhone,
        is_delivery: false,
        delivery_address: "",
      }),
    });
    if (res.ok) {
      const result = await res.json();
      closePaymentPanel();

      showToast("Invoice generated successfully!", "success");

      // Record used barcodes in local cache
      posCart.forEach((item) => {
        if (item.barcodes) {
          item.barcodes.forEach((bc) => soldBarcodes.add(bc));
        }
      });

      printReceipt(
        posCart,
        total,
        result.invoice_number || result.receipt_no || result.transaction_id,
        "INVOICE",
        0,
        buyerName,
        null,
        true,
      );

      // Disable print invoice button after successful print — re-enables when new items are added
      if (_btnPI) {
        _btnPI.disabled = true;
        _btnPI.style.opacity = "0.45";
        _btnPI.style.pointerEvents = "none";
        _btnPI.innerHTML = '<i class="fa-solid fa-check"></i> Printed';
      }

      posCart = [];
      renderCart();
      loadPOSProducts();
      loadDashboard();
      loadTransactions();
      const smeProdView = document.getElementById("sme-view-products");
      if (smeProdView && smeProdView.style.display !== "none" && typeof loadSmeProductSales === "function") {
        loadSmeProductSales();
      }
      const invSection = document.getElementById("inventory");
      if (invSection && invSection.classList.contains("active") && typeof loadInventory === "function") {
        loadInventory();
      }
      if (typeof loadPendingCOD === "function") loadPendingCOD(true); // force=true: bypass cache after invoice
    } else {
      const data = await res.json();
      alert("Error: " + data.error);
    }
  } catch (e) {
    if (
      !navigator.onLine ||
      e.message.toLowerCase().includes("failed to fetch")
    ) {
      const offlinePayload = {
        total_amount: total,
        items: posCart,
        payment_method: "INVOICE",
        amount_paid: 0,
        buyer_name: buyerName,
        buyer_phone: buyerPhone,
      };
      if (window.OfflineDB) {
        await window.OfflineDB.queueOfflineSale(client_uuid, offlinePayload);
      }
      closePaymentPanel();
      showToast("📶 Offline — invoice saved locally.", "warning");

      posCart.forEach((item) => {
        if (item.barcodes) {
          item.barcodes.forEach((bc) => soldBarcodes.add(bc));
        }
      });

      printReceipt(
        posCart,
        total,
        `OFFLINE-${client_uuid.slice(0, 8).toUpperCase()}`,
        "INVOICE",
        0,
        buyerName,
        null,
        true,
      );

      posCart = [];
      renderCart();
      updateSyncBadge();
      return;
    }
    alert("Invoice generation failed: " + e.message);
  } finally {
    _isGettingInvoice = false;
    if (_btnPI && _btnPI.innerHTML.includes("Processing")) {
      _btnPI.disabled = false;
      _btnPI.innerHTML = origPIHtml || '<i class="fa-solid fa-print"></i> PRINT INVOICE';
    }
  }
}

// ============================================================
// OFFLINE SALES SYNC ENGINE
// ============================================================

async function syncOfflineSales() {
  if (!window.OfflineDB) return;
  const pending = await window.OfflineDB.getPendingOfflineSales();
  if (!pending.length) return;

  const token = localStorage.getItem("jomish_token");
  if (!token) return;

  try {
    const res = await fetch(`${API_URL}/pos/batch-sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ transactions: pending }),
    });

    if (!res.ok) throw new Error(`Server responded ${res.status}`);

    const { syncedIds = [], errors = [] } = await res.json();

    if (syncedIds.length) {
      await window.OfflineDB.removeSyncedSales(syncedIds);
      showToast(
        `✅ ${syncedIds.length} offline sale(s) synced to server.`,
        "success",
      );
    }
    if (errors.length) {
      console.warn("[Sync] Failed to sync some sales:", errors);
    }
  } catch (e) {
    console.warn(
      "[Sync] Batch sync failed \u2014 will retry on next reconnect:",
      e.message,
    );
  }

  updateSyncBadge();
}

async function updateSyncBadge() {
  if (!window.OfflineDB) return;
  const count = await window.OfflineDB.getPendingCount();
  let badge = document.getElementById("offline-sync-badge");
  if (count > 0) {
    if (!badge) {
      // Find a safe spot in POS UI to anchor the badge. The nav bar is ideal.
      badge = document.createElement("span");
      badge.id = "offline-sync-badge";
      badge.style.cssText =
        "position:fixed;top:14px;right:14px;background:#EF4444;color:#fff;border-radius:20px;padding:4px 10px;font-size:0.78rem;font-weight:700;z-index:9999;display:flex;align-items:center;gap:5px;box-shadow:0 2px 8px rgba(0,0,0,0.2);cursor:pointer;";
      badge.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> <span id="offline-sync-count">${count}</span> pending`;
      badge.title = "Offline sales pending sync — click to retry";
      badge.onclick = syncOfflineSales;
      document.body.appendChild(badge);
    } else {
      const countEl = document.getElementById("offline-sync-count");
      if (countEl) countEl.textContent = count;
    }
    if (badge) badge.remove();
  }
  if (typeof window.updateAppOnlineStatus === "function") window.updateAppOnlineStatus();
}

// ============================================================
// RECEIPT & INVOICE PRINTING — Clean rebuild
// ============================================================

// Holds the current receipt data for the print window
let _currentReceiptData = null;

/**
 * Populate and show the on-screen receipt modal.
 * Called after every successful checkout or invoice generation.
 */
function printReceipt(
  items,
  total,
  orderId,
  paymentMethod = "CASH",
  amountPaid = null,
  buyerName = null,
  deliveryInfo = null,
  isInvoice = false,
  servedBy = null,
  originalTotal = null,
) {
  // ── Business info ─────────────────────────────────────
  const bizName = localStorage.getItem("jomish_biz_name") || "Jomish Business";
  const bizLoc =
    localStorage.getItem("jomish_biz_location") || "Kampala, Uganda";
  const bizTel = localStorage.getItem("jomish_biz_contact") || "";
  const taxRate = parseFloat(localStorage.getItem("jomish_tax_rate") || "0");

  // ── Calculations ──────────────────────────────────────
  const paid = amountPaid !== null ? amountPaid : total;
  const sub = taxRate > 0 ? total / (1 + taxRate / 100) : total;
  const tax = total - sub;
  const change =
    paymentMethod !== "CREDIT" && paymentMethod !== "INVOICE" && paymentMethod !== "DISCOUNT"
      ? Math.max(0, paid - total)
      : 0;
  const bal =
    paymentMethod === "CREDIT" || paymentMethod === "INVOICE"
      ? Math.max(0, total - paid)
      : 0;
  const docPrefix = isInvoice ? "INV" : "RCPT";
  const orderNo = formatDocNo(docPrefix, orderId || Math.floor(Math.random() * 999));
  const dateStr = new Date().toLocaleString("en-UG", {
    timeZone: "Africa/Kampala",
  });

  // ── Store receipt data for the print window ────────────
  _currentReceiptData = {
    isInvoice,
    bizName,
    bizLoc,
    bizTel,
    taxRate,
    orderId: orderNo,
    dateStr,
    cashierName: USER_NAME || "Cashier",
    servedBy: servedBy || null,
    items: items.map((i) => ({
      name: i.name,
      qty: i.qty || 1,
      price: i.price,
    })),
    sub,
    tax,
    total,
    originalTotal,
    paid,
    change,
    bal,
    paymentMethod: deliveryInfo ? `${paymentMethod} (DELIVERY)` : paymentMethod,
    buyerName,
    deliveryInfo,
  };

  // ── Populate the on-screen receipt modal ───────────────
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  set("receipt-biz-name", bizName);
  set("receipt-addr", bizLoc);
  set("receipt-contact", bizTel);
  set("receipt-date", "Date: " + dateStr);
  set("receipt-no", orderNo);
  set("receipt-cashier", "Cashier: " + (USER_NAME || "Cashier"));
  const servedByEl = document.getElementById("receipt-served-by");
  if (servedByEl) {
    if (servedBy) {
      servedByEl.textContent = "Served by: " + servedBy;
      servedByEl.style.display = "inline";
    } else {
      servedByEl.style.display = "none";
    }
  }

  // Items
  const tbody = document.getElementById("receipt-items");
  if (tbody) {
    tbody.innerHTML = "";
    items.forEach((i) => {
      const qty = i.qty || 1;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="padding:2px 0 2px 0; word-break:break-word; white-space:normal;">${i.name}</td>
        <td style="padding:2px 0; text-align:left;">${qty}</td>
        <td style="padding:2px 0; text-align:left; white-space:nowrap; font-weight:600;">${(i.price * qty).toLocaleString()}</td>`;
      tbody.appendChild(tr);
    });
  }

  set("r-subtotal", `${Math.round(sub).toLocaleString()}`);
  set(
    "r-tax",
    taxRate > 0
      ? `${Math.round(tax).toLocaleString()} (${taxRate}%)`
      : "0",
  );
  set("r-total", `${Math.round(total).toLocaleString()}`);
  set("r-method", paymentMethod);
  set("r-paid", `${Math.round(paid).toLocaleString()}`);

  // Conditional rows
  const show = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? "flex" : "none";
  };

  if (change > 0) {
    set("r-change", `${Math.round(change).toLocaleString()}`);
    show("r-change-row", true);
  } else {
    show("r-change-row", false);
  }

  if (bal > 0) {
    set("r-balance", `${Math.round(bal).toLocaleString()}`);
    show("r-balance-row", true);
  } else {
    show("r-balance-row", false);
  }

  if (buyerName) {
    set("r-buyer-name", buyerName);
    show("r-buyer-row", true);
  } else {
    show("r-buyer-row", false);
  }

  if (deliveryInfo) {
    if (typeof deliveryInfo === "object") {
      set(
        "r-delivery-client",
        `${deliveryInfo.clientName || ""} ${deliveryInfo.clientPhone ? "(" + deliveryInfo.clientPhone + ")" : ""}`.trim(),
      );
      set("r-delivery-loc", deliveryInfo.clientLocation || "");
    } else {
      set("r-delivery-client", String(deliveryInfo));
      set("r-delivery-loc", "");
    }
    const dRow = document.getElementById("r-delivery-row");
    if (dRow) dRow.style.display = "block";
  } else {
    const dRow = document.getElementById("r-delivery-row");
    if (dRow) dRow.style.display = "none";
  }

  // Logo
  const logo = document.getElementById("receipt-brand-logo");
  if (logo) {
    const savedLogo = localStorage.getItem("jomish_logo_base64");
    logo.src = savedLogo || "assets/default-logo.png";
    logo.style.display = "";
  }

  // Use doPrint() so kitchen token is always printed first for invoices
  doPrint();
}

/**
 * End Shift and Print Report
 */
// ── CASHIER SHIFTS (START & END RECONCILIATION) ────────────────────────
let _updateShiftUIInFlight = false;
window.updateCashierShiftUI = async function () {
  const shiftControls = document.getElementById("pos-shift-controls");
  const btnStartShift = document.getElementById("btn-start-shift");
  const btnEndShift = document.getElementById("btn-end-shift");
  const shiftBanner = document.getElementById("active-shift-banner");
  const shiftInfo = document.getElementById("active-shift-info");

  const _role = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
  if (_role !== "CASHIER") {
    if (shiftControls) shiftControls.style.setProperty("display", "none", "important");
    if (btnStartShift) btnStartShift.style.setProperty("display", "none", "important");
    if (btnEndShift) btnEndShift.style.setProperty("display", "none", "important");
    if (shiftBanner) shiftBanner.style.setProperty("display", "none", "important");
    return;
  }

  // Prevent concurrent calls from racing each other
  if (_updateShiftUIInFlight) return;
  _updateShiftUIInFlight = true;

  // Only Cashier sees the shift controls — show immediately so the UI doesn't flicker
  if (shiftControls) shiftControls.style.setProperty("display", "flex", "important");

  try {
    const res = await fetchAuth(`${API_URL}/pos/current-shift`);
    if (res.ok) {
      const data = await res.json();
      window._hasActiveCashierShift = !!(data.has_active_shift && data.shift);
      window._activeCashierShiftData = data.shift || null;
      if (data.has_active_shift && data.shift) {
        try { localStorage.setItem("jomish_active_shift", "true"); } catch (_) {}
        // Active shift is running: Start Shift is faded/disabled, End Shift is unfaded/active
        if (btnStartShift) {
          btnStartShift.style.setProperty("display", "inline-flex", "important");
          btnStartShift.disabled = true;
          btnStartShift.setAttribute("data-shift-active", "true");
          btnStartShift.style.opacity = "0.4";
          btnStartShift.style.cursor = "default";
          btnStartShift.style.pointerEvents = "none";
          btnStartShift.style.filter = "grayscale(70%)";
          btnStartShift.title = "Shift is already in progress";
          btnStartShift.innerHTML = '<i class="fa-solid fa-check"></i> Shift Started';
        }
        if (btnEndShift) {
          btnEndShift.style.setProperty("display", "inline-flex", "important");
          btnEndShift.disabled = false;
          btnEndShift.style.opacity = "1";
          btnEndShift.style.cursor = "pointer";
          btnEndShift.style.pointerEvents = "auto";
          btnEndShift.style.filter = "none";
          btnEndShift.title = "End shift and calculate cash drawer";
          btnEndShift.innerHTML = '<i class="fa-solid fa-power-off"></i> End Shift';
        }
        if (shiftBanner && shiftInfo) {
          shiftBanner.style.setProperty("display", "inline-flex", "important");
          const startTimeStr = new Date(data.shift.start_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          shiftInfo.textContent = `Started ${startTimeStr} • Opening Income: UGX ${Number(data.shift.start_cash || 0).toLocaleString()}`;
        }
      } else {
        try { localStorage.removeItem("jomish_active_shift"); } catch (_) {}
        // No shift started yet: Start Shift is unfaded/active, End Shift is faded/disabled
        if (btnStartShift) {
          btnStartShift.style.setProperty("display", "inline-flex", "important");
          btnStartShift.disabled = false;
          btnStartShift.removeAttribute("data-shift-active");
          btnStartShift.style.opacity = "1";
          btnStartShift.style.cursor = "pointer";
          btnStartShift.style.pointerEvents = "auto";
          btnStartShift.style.filter = "none";
          btnStartShift.title = "Start your shift";
          btnStartShift.innerHTML = '<i class="fa-solid fa-play"></i> Start Shift';
        }
        if (btnEndShift) {
          btnEndShift.style.setProperty("display", "inline-flex", "important");
          btnEndShift.disabled = true;
          btnEndShift.style.opacity = "0.35";
          btnEndShift.style.cursor = "not-allowed";
          btnEndShift.style.pointerEvents = "none";
          btnEndShift.style.filter = "grayscale(80%)";
          btnEndShift.title = "Start a shift first before ending";
          btnEndShift.innerHTML = '<i class="fa-solid fa-power-off"></i> End Shift';
        }
        window._hasActiveCashierShift = false;
        window._activeCashierShiftData = null;
        if (shiftBanner) {
          shiftBanner.style.setProperty("display", "none", "important");
        }
      }
    }
  } catch (e) {
    console.error("Failed to check cashier shift status:", e);
  } finally {
    _updateShiftUIInFlight = false;
  }
};

window.openStartShiftModal = function (e) {
  if (e && e.preventDefault) e.preventDefault();
  const btnStartShift = document.getElementById("btn-start-shift");
  if (btnStartShift && (btnStartShift.disabled || btnStartShift.getAttribute("data-shift-active") === "true")) {
    showToast("Your shift is already in progress. Tap 'End Shift' when finished.", "info");
    return;
  }
  const modal = document.getElementById("start-shift-modal");
  const input = document.getElementById("start-shift-cash-input");
  if (input) input.value = "";
  if (modal) modal.classList.remove("hidden");
  setTimeout(() => input && input.focus(), 150);
};

window.closeStartShiftModal = function () {
  const modal = document.getElementById("start-shift-modal");
  if (modal) modal.classList.add("hidden");
};

let _confirmStartShiftLock = false;
window.confirmStartShift = async function (e) {
  if (e && e.preventDefault) e.preventDefault();
  if (e && e.stopPropagation) e.stopPropagation();
  if (_confirmStartShiftLock) return;
  _confirmStartShiftLock = true;
  setTimeout(() => { _confirmStartShiftLock = false; }, 1000);

  const input = document.getElementById("start-shift-cash-input");
  const val = input ? input.value.trim() : "";
  const startCash = parseFloat(val);
  if (val === "" || isNaN(startCash) || startCash <= 0) {
    showToast("Please enter your starting cash / opening capital amount to begin your shift.", "warning");
    if (input) input.focus();
    _confirmStartShiftLock = false;
    return;
  }

  const btn = document.getElementById("btn-submit-start-shift");
  const origHtml = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Starting...';
  }

  try {
    const res = await fetchAuth(`${API_URL}/pos/start-shift`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start_cash: startCash }),
    });
    const data = await res.json();
    if (res.ok) {
      closeStartShiftModal();

      // Immediately fade start button and unfade end button
      const btnStart = document.getElementById("btn-start-shift");
      const btnEnd = document.getElementById("btn-end-shift");
      const banner = document.getElementById("active-shift-banner");
      const info = document.getElementById("active-shift-info");

      if (btnStart) {
        btnStart.style.setProperty("display", "inline-flex", "important");
        btnStart.disabled = true;
        btnStart.setAttribute("data-shift-active", "true");
        btnStart.style.opacity = "0.4";
        btnStart.style.pointerEvents = "none";
        btnStart.style.cursor = "default";
        btnStart.style.filter = "grayscale(70%)";
        btnStart.title = "Shift is already in progress";
        btnStart.innerHTML = '<i class="fa-solid fa-check"></i> Shift Started';
      }
      if (btnEnd) {
        btnEnd.style.setProperty("display", "inline-flex", "important");
        btnEnd.disabled = false;
        btnEnd.style.opacity = "1";
        btnEnd.style.pointerEvents = "auto";
        btnEnd.style.cursor = "pointer";
        btnEnd.style.filter = "none";
        btnEnd.title = "End shift and calculate cash drawer";
        btnEnd.innerHTML = '<i class="fa-solid fa-power-off"></i> End Shift';
      }
      if (banner && info) {
        banner.style.setProperty("display", "inline-flex", "important");
        const timeStr = new Date(data.start_time || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        info.textContent = `Started ${timeStr} • Opening Income: UGX ${startCash.toLocaleString()}`;
      }

      window._hasActiveCashierShift = true;
      try { localStorage.setItem("jomish_active_shift", "true"); } catch (_) {}
      showToast(`Shift started! Opening Income: UGX ${startCash.toLocaleString()}`, "success");
      await updateCashierShiftUI();
    } else {
      alert("Error starting shift: " + (data.error || "Unknown error"));
    }
  } catch (e) {
    console.error("Error starting shift:", e);
    alert("Network error while starting shift.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml || '<i class="fa-solid fa-check"></i> Start Shift';
    }
    _confirmStartShiftLock = false;
  }
};

// Holds the shift report data while cashier reviews the preview
let _pendingShiftReport = null;
let _pendingShiftCountedCash = null;

window.openEndShiftModal = async function () {
  const btnEndShift = document.getElementById("btn-end-shift");
  if (btnEndShift && btnEndShift.disabled) {
    showToast("No active shift found. Please click 'Start Shift' and enter your starting capital first.", "warning");
    return;
  }
  const origHtml = btnEndShift ? btnEndShift.innerHTML : "";
  if (btnEndShift) {
    btnEndShift.disabled = true;
    btnEndShift.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading preview...';
  }

  try {
    const res = await fetchAuth(`${API_URL}/pos/shift-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const report = await res.json();
    if (res.ok) {
      _pendingShiftReport = report;
      _pendingShiftCountedCash = Number(report.end_cash || 0);
      _buildShiftPreview(report);
      const previewModal = document.getElementById("end-shift-preview-modal");
      if (previewModal) previewModal.classList.remove("hidden");
    } else {
      showToast(report.error || "Error loading shift preview", "danger");
    }
  } catch (e) {
    console.error("Shift preview error:", e);
    showToast("Network error while loading shift preview.", "danger");
  } finally {
    if (btnEndShift) {
      btnEndShift.disabled = false;
      btnEndShift.innerHTML = origHtml;
    }
  }
};

window.closeEndShiftModal = function () {
  closeEndShiftPreviewModal();
};

window.closeEndShiftPreviewModal = function () {
  const modal = document.getElementById("end-shift-preview-modal");
  if (modal) modal.classList.add("hidden");
};

// Cancel from the preview — shift continues untouched
window.cancelEndShift = function () {
  closeEndShiftPreviewModal();
  _pendingShiftReport = null;
  _pendingShiftCountedCash = null;
};

function _buildShiftPreview(r) {
  const el = document.getElementById("shift-preview-content");
  if (!el) return;
  const grandTotal   = Number(r.end_cash || 0);          // cash + momo
  const cashOnly     = Number(r.cash_in_drawer !== undefined ? r.cash_in_drawer : (grandTotal - Number(r.momo_sales || 0)));
  const momoSales    = Number(r.momo_sales || 0);
  const fmt = (n) => "UGX " + Number(n || 0).toLocaleString();
  const row = (label, val, color) =>
    '<div style="display:flex;justify-content:space-between;margin-bottom:6px;' + (color ? 'color:' + color + ';font-weight:700;' : '') + '">' +
    '<span>' + label + '</span><span>' + val + '</span></div>';
  const divider = '<div style="border-top:1px dashed var(--border);margin:10px 0;"></div>';

  el.innerHTML =
    '<div style="text-align:center;font-weight:800;font-size:1.05rem;margin-bottom:6px;">' + (localStorage.getItem("jomish_biz_name") || "Jomish Business") + '</div>' +
    '<div style="text-align:center;margin-bottom:12px;font-size:0.82rem;color:var(--text-muted);">Cashier: <strong>' + (r.cashier_name || "Cashier") + '</strong></div>' +
    divider +
    row("Shift Started:", new Date(r.start_time).toLocaleString("en-UG")) +
    row("(+) Opening Income / Capital:", fmt(r.start_cash)) +
    divider +
    row("(+) Cash Sales:", fmt(r.cash_sales)) +
    row("(+) Mobile Money Sales:", fmt(momoSales), "#7c3aed") +
    (Number(r.income_transactions || 0) > 0 ? row("(+) Income (Manual):", fmt(r.income_transactions), "#16a34a") : "") +
    row("(+) Cash In (Float):", fmt(r.cash_in), "#16a34a") +
    row("(-) Expenses / Cash Out:", "-" + fmt(r.expenses), "#dc2626") +
    divider +
    // Grand total (cash + momo)
    '<div style="display:flex;justify-content:space-between;font-weight:800;font-size:1.05rem;margin:6px 0;color:var(--text);background:rgba(99,102,241,0.08);padding:8px 10px;border-radius:6px;">' +
      '<span>Total Collected:</span><span>' + fmt(grandTotal) + '</span>' +
    '</div>' +
    // MOMO sub-note
    (momoSales > 0 ?
      '<div style="display:flex;justify-content:space-between;font-size:0.82rem;color:#7c3aed;padding:4px 10px 0;">' +
        '<span>&#x2937; of which on Mobile Money:</span><span>' + fmt(momoSales) + '</span>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:0.82rem;color:var(--text-muted);padding:2px 10px 6px;">' +
        '<span>&#x2937; Physical Cash in Drawer:</span><span>' + fmt(cashOnly) + '</span>' +
      '</div>'
    : "") +
    divider +
    '<div style="font-size:0.8rem;color:var(--text-muted);">' +
      row("Total Sales (All Methods):", fmt(r.total_sales)) +
      (r.invoice_collected ? row("Invoices/COD Collected:", fmt(r.invoice_collected)) : "") +
      (r.discount_amount ? row("Discounts Given:", "-" + fmt(r.discount_amount), "#f59e0b") : "") +
    '</div>';
}

// Cashier confirmed from preview — NOW actually end the shift
window.finaliseEndShift = async function () {
  if (!_pendingShiftReport || _pendingShiftCountedCash === null) {
    showToast("No pending shift data. Please try again.", "warning");
    return;
  }
  const btn = document.getElementById("btn-confirm-end-shift");
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Ending Shift...'; }

  try {
    const res = await fetchAuth(`${API_URL}/pos/end-shift`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ counted_cash: _pendingShiftCountedCash }),
    });
    const report = await res.json();
    if (res.ok) {
      closeEndShiftPreviewModal();
      window._hasActiveCashierShift = false;
      window._activeCashierShiftData = null;
      try { localStorage.removeItem("jomish_active_shift"); } catch (_) {}
      showToast(`Shift ended! Total Cash: UGX ${Number(report.end_cash || 0).toLocaleString()}`, "success");

      // Print then log out — shift is already CLOSED in the DB
      setTimeout(() => {
        printEndShiftReport(report);
        setTimeout(() => {
          const keysToRemove = [
            "jomish_token", "jomish_role", "jomish_name", "jomish_permissions",
            "jomish_user_id", "jomish_prefix", "jomish_active_shift"
          ];
          keysToRemove.forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
          location.replace("login.html");
        }, 1500);
      }, 600);
    } else {
      alert("Error ending shift: " + (report.error || "Unknown error"));
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-print"></i> Yes, Print & End'; }
    }
  } catch (e) {
    console.error("End shift error:", e);
    alert("Network error while ending shift.");
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-print"></i> Yes, Print & End'; }
  }
};

window.endCashierShift = function () {
  openEndShiftModal();
};

window.printEndShiftReport = function(report) {
  const bizName = localStorage.getItem("jomish_biz_name") || "Jomish Business";
  const grandTotal  = Number(report.end_cash || 0);
  const cashOnly    = Number(report.cash_in_drawer !== undefined ? report.cash_in_drawer : (grandTotal - Number(report.momo_sales || 0)));
  const momoSales   = Number(report.momo_sales || 0);
  const countedCash = Number(report.counted_cash !== undefined ? report.counted_cash : grandTotal);
  const diff = Number(report.difference !== undefined ? report.difference : (countedCash - grandTotal));

  let diffLabel = "BALANCED";
  let diffColor = "#16a34a";
  if (diff > 0) {
    diffLabel = `EXCESS (+UGX ${diff.toLocaleString()})`;
    diffColor = "#2563eb";
  } else if (diff < 0) {
    diffLabel = `SHORTAGE (-UGX ${Math.abs(diff).toLocaleString()})`;
    diffColor = "#dc2626";
  }
  
  const html = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <style>
          @page { size: 80mm auto; margin: 3mm 2mm; }
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: 'Courier New', Courier, monospace; font-size: 11pt; line-height: 1.4; width: 76mm; color: #000; background: #fff; padding: 10px; }
          .center { text-align: center; }
          .bold { font-weight: bold; }
          .row { display: flex; margin-bottom: 5px; }
          .row > span:first-child { width: 50%; }
          .row > span:last-child { width: 50%; text-align: left; }
          .divider { border-top: 1px dashed #000; margin: 6px 0; }
        </style>
      </head>
      <body>
        <div class="center bold" style="font-size:16pt; margin-bottom: 5px;">${bizName}</div>
        <div class="center bold" style="font-size:14pt; margin-bottom: 10px;">CASHIER SHIFT REPORT</div>
        <div class="row"><span>Cashier:</span><span class="bold">${report.cashier_name}</span></div>
        <div class="row"><span>Started:</span><span>${new Date(report.start_time).toLocaleString("en-UG")}</span></div>
        <div class="row"><span>Ended:</span><span>${new Date(report.end_time).toLocaleString("en-UG")}</span></div>
        <div class="divider"></div>
        <div style="font-weight:bold; font-size:11pt; margin-bottom:5px;">CASH DRAWER RECONCILIATION</div>
        <div class="row"><span>Starting Capital:</span><span>UGX ${(report.start_cash || 0).toLocaleString()}</span></div>
        <div class="row"><span>(+) Cash Sales:</span><span>UGX ${(report.cash_sales || 0).toLocaleString()}</span></div>
        <div class="row" style="color:#7c3aed; font-weight:bold;"><span>(+) Mobile Money:</span><span>+UGX ${momoSales.toLocaleString()}</span></div>
        ${Number(report.income_transactions || 0) > 0 ? `<div class="row" style="color:#16a34a; font-weight:bold;"><span>(+) Income (Manual):</span><span>+UGX ${Number(report.income_transactions).toLocaleString()}</span></div>` : ""}
        <div class="row" style="color:#16a34a; font-weight:bold;"><span>(+) Cash In (Float):</span><span>+UGX ${(report.cash_in || 0).toLocaleString()}</span></div>
        <div class="row" style="color:#dc2626; font-weight:bold;"><span>(-) Cashier Expenses:</span><span>-UGX ${(report.expenses || 0).toLocaleString()}</span></div>
        <div class="divider"></div>
        <div class="row bold" style="font-size:12.5pt;"><span>Total Collected:</span><span>UGX ${grandTotal.toLocaleString()}</span></div>
        ${momoSales > 0 ? `<div class="row" style="font-size:9.5pt;color:#7c3aed;"><span>  ↳ on Mobile Money:</span><span>UGX ${momoSales.toLocaleString()}</span></div>
        <div class="row" style="font-size:9.5pt;color:#555;"><span>  ↳ Physical Cash in Drawer:</span><span>UGX ${cashOnly.toLocaleString()}</span></div>` : ""}
        <div class="row bold" style="font-size:12.5pt;"><span>Cash Counted (Actual):</span><span>UGX ${countedCash.toLocaleString()}</span></div>
        <div class="row bold" style="font-size:11pt; color:${diffColor};"><span>Reconciliation:</span><span>${diffLabel}</span></div>
        <div class="divider"></div>
        <div style="font-weight:bold; margin-bottom:4px;">SALES BREAKDOWN</div>
        <div class="row"><span>Cash Sales:</span><span>UGX ${(report.cash_sales || 0).toLocaleString()}</span></div>
        <div class="row"><span>Mobile Money:</span><span>UGX ${(report.momo_sales || 0).toLocaleString()}</span></div>
        <div class="row bold"><span>Total Sales (All):</span><span>UGX ${(report.total_sales || 0).toLocaleString()}</span></div>
        ${Number(report.income_transactions || 0) > 0 ? `<div class="row"><span>Income Transactions:</span><span>UGX ${Number(report.income_transactions).toLocaleString()}</span></div>` : ""}
        ${report.invoice_collected ? `<div class="row"><span>Invoices/COD Paid:</span><span>UGX ${Number(report.invoice_collected).toLocaleString()}</span></div>` : ''}
        ${report.discount_amount ? `<div class="row" style="color:#f59e0b; font-weight:bold;"><span>(-) Discounts Given:</span><span>-UGX ${Number(report.discount_amount).toLocaleString()}</span></div>` : ''}
        <div class="divider"></div>
        <div class="center" style="margin-top: 20px;">Cashier: ____________________</div>
        <div class="center" style="margin-top: 12px;">Supervisor: _________________</div>
      </body>
    </html>
  `;
  
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:absolute;width:0;height:0;border:none;left:-9999px;top:-9999px;";
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  
  iframe.onload = () => {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => iframe.remove(), 1000);
  };
};

/**
 * Close the on-screen receipt modal.
 */
function closeReceipt() {
  const overlay = document.getElementById("receipt-overlay");
  if (overlay) overlay.classList.remove("receipt-modal-visible");
  _currentReceiptData = null;
}

function _buildKitchenTokenHTML(d) {
  let tokenItems = "";
  const isEdited = !!d.isEdited;

  d.items.forEach((i) => {
    const qty = i.qty || 1;
    const addedQty = i.addedQty !== undefined ? i.addedQty : (isEdited ? qty : 0);
    const origQty = i.origQty !== undefined ? i.origQty : 0;

    let editBadge = "";
    if (isEdited) {
      if (origQty === 0 || i.isNew) {
        editBadge = `<div style="font-size:11pt; font-weight:bold; color:#000; margin-top:2px;">&#9658; [ADDED: ${i.name} x ${qty}]</div>`;
      } else if (addedQty > 0) {
        editBadge = `<div style="font-size:10pt; font-weight:bold; color:#000; margin-top:2px;">&#9658; [+${addedQty} ADDED (Was ${origQty}, Now ${qty})]</div>`;
      } else {
        editBadge = `<div style="font-size:9pt; color:#666; font-style:italic; margin-top:1px;">(Prev. ordered: ${origQty})</div>`;
      }
    }

    tokenItems += `
      <tr>
          <td style="padding:4px 0; word-break:break-word; white-space:normal; font-size:13pt; font-weight:bold;">
            ${i.name} x ${qty}
            ${editBadge}
          </td>
          <td style="padding:4px 0; text-align:right; font-size:15pt; font-weight:bold; vertical-align:top;">x${qty}</td>
      </tr>`;
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>KITCHEN TOKEN ${d.orderId}</title>
<style>
/* ─── 80mm thermal roll paper ─── */
@page { size: 80mm auto; margin: 3mm 2mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Courier New', Courier, monospace; font-size: 11pt; line-height: 1.4; width: 76mm; color: #000; background: #fff; }
.center { text-align: center; }
.heading { font-size: 16pt; font-weight: bold; text-align: center; margin: 4px 0; }
.row { display: flex; margin: 2px 0; font-size: 12pt; font-weight:bold; }
.divider { border-top: 1px dashed #888; margin: 6px 0; }
table { width: 100%; border-collapse: collapse; }
.meta { font-size: 9pt; color: #444; }
</style>
</head>
<body>
    <div class="center heading" style="font-size:16pt;">KITCHEN TOKEN</div>
    ${d.isEdited ? `<div class="center" style="background:#000;color:#fff;font-weight:bold;font-size:13pt;padding:4px;letter-spacing:1px;margin:4px 0;">*** EDITED ORDER ***<br><span style="font-size:10pt;">SEE ADDED ITEMS BELOW</span></div>` : ""}
    <div class="row"><span style="font-size:12pt; font-weight:bold;">Order: ${d.orderId}</span></div>
    <div class="row"><span>Date: ${d.dateStr}</span></div>
    ${d.servedBy ? `<div class="row"><span>Served by: ${d.servedBy}</span></div>` : ""}
    <div class="divider"></div>
    <table>
        <thead>
            <tr>
                <th style="text-align:left; width:75%;">Item</th>
                <th style="text-align:right; width:25%;">Qty</th>
            </tr>
        </thead>
        <tbody>${tokenItems}</tbody>
    </table>
    <div class="divider"></div>
    <div class="center meta" style="margin-top:10px;">End of Token</div>
</body>
</html>`;
}

/**
 * Build the receipt HTML string for printing.
 * Used by doPrint() to create the print window.
 */
function _buildReceiptHTML(d) {
  const fmtUGX = (n) => Math.round(n).toLocaleString();
  const heading = d.isInvoice ? "INVOICE" : "RECEIPT";

  let itemRows = "";
  d.items.forEach((i) => {
    const qty = i.qty || 1;
    const lineTotal = i.price * qty;
    itemRows += `
            <tr>
                <td style="padding:3px 0; word-break:break-word; white-space:normal;">${i.name}</td>
                <td style="padding:3px 0; text-align:left;">${qty}</td>
                <td style="padding:3px 0; text-align:left; white-space:nowrap; font-weight:bold;">${Math.round(lineTotal).toLocaleString()}</td>
            </tr>`;
  });

  let conditionalRows = "";
  if (d.taxRate > 0) {
    conditionalRows += `<div class="row"><span>Tax (${d.taxRate}%):</span><span>${fmtUGX(d.tax)}</span></div>`;
  }
  if (d.originalTotal && String(d.paymentMethod).includes("DISCOUNT") && d.originalTotal !== d.total) {
    const discAmount = d.originalTotal - d.total;
    conditionalRows += `<div class="row" style="color:#666;"><span>Original Total:</span><span>UGX ${fmtUGX(d.originalTotal)}</span></div>`;
    conditionalRows += `<div class="row" style="color:#10B981;font-weight:bold;"><span>Discount:</span><span>-UGX ${fmtUGX(discAmount)}</span></div>`;
  }
  if (d.change > 0) {
    conditionalRows += `<div class="row" style="color:#10B981;font-weight:bold;"><span>Change:</span><span>${fmtUGX(d.change)}</span></div>`;
  }
  if (d.bal > 0) {
    conditionalRows += `<div class="row" style="color:#EF4444;font-weight:bold;"><span>Balance Due:</span><span>${fmtUGX(d.bal)}</span></div>`;
  }
  if (d.buyerName) {
    conditionalRows += `<div class="row"><span>Buyer:</span><span>${d.buyerName}</span></div>`;
  }

  let deliveryBlock = "";
  if (d.deliveryInfo) {
    const clientStr =
      typeof d.deliveryInfo === "object"
        ? `${d.deliveryInfo.clientName || ""} ${d.deliveryInfo.clientPhone ? "(" + d.deliveryInfo.clientPhone + ")" : ""}`.trim()
        : String(d.deliveryInfo);
    const locStr =
      typeof d.deliveryInfo === "object"
        ? d.deliveryInfo.clientLocation || ""
        : "";
    deliveryBlock = `
            <div class="divider"></div>
            <div style="font-weight:bold;margin-bottom:3px;">🚚 DELIVERY</div>
            <div class="row"><span>Client:</span><span>${clientStr}</span></div>
            ${locStr ? `<div class="row"><span>Location:</span><span>${locStr}</span></div>` : ""}`;
  }

  const logoSrc =
    localStorage.getItem("jomish_logo_base64") || "assets/default-logo.png";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${heading} ${d.orderId}</title>
<style>
/* ─── 80mm thermal roll paper ─── */
@page {
    size: 80mm auto;
    margin: 3mm 2mm;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: 'Courier New', Courier, monospace;
    font-size: 11pt;
    line-height: 1.4;
    width: 76mm;
    color: #000;
    background: #fff;
}
/* Screen preview */
@media screen {
    body {
        max-width: 320px;
        margin: 20px auto;
        padding: 16px;
        font-size: 12px;
        border: 1px dashed #aaa;
        border-radius: 4px;
        background: #fff;
    }
}
.center    { text-align: center; }
.bold      { font-weight: bold; }
.upper     { text-transform: uppercase; }
.biz-name  { font-size: 14pt; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; }
.meta      { font-size: 9pt; color: #444; }
.divider   { border-top: 1px dashed #888; margin: 6px 0; }
.divider-solid { border-top: 1px solid #000; margin: 6px 0; }
.heading   { font-size: 13pt; font-weight: bold; text-align: center; margin: 4px 0; }
.row       { display: flex; margin: 2px 0; font-size: 10pt; }
.row > span:first-child, .row > strong:first-child { width: 50%; }
.row > span:last-child, .row > strong:last-child { width: 50%; text-align: left; }
.total-row { display: flex; font-weight: bold; font-size: 12pt; margin-top: 4px; }
.total-row > span:first-child { width: 50%; }
.total-row > span:last-child { width: 50%; text-align: left; }
table      { width: 100%; border-collapse: collapse; }
th, td     { font-size: 10pt; vertical-align: top; }
th         { border-bottom: 1px dashed #888; padding: 3px 0; }
.footer    { text-align: center; font-size: 9pt; color: #555; margin-top: 10px; padding-top: 6px; border-top: 1px dashed #888; }
.logo      { max-height: 52px; max-width: 140px; }
</style>
</head>
<body>

<!-- Logo -->
<div class="center" style="margin-bottom:6px;">
    <img class="logo" src="${logoSrc}" alt="" onerror="this.style.display='none'">
</div>

<!-- Business info -->
<div class="center" style="margin-bottom:8px;">
    <div class="biz-name">${d.bizName}</div>
    ${d.bizLoc ? `<div class="meta">${d.bizLoc}</div>` : ""}
    ${d.bizTel ? `<div class="meta">${d.bizTel}</div>` : ""}
</div>

<div class="divider"></div>

<!-- Receipt heading -->
<div class="heading">${heading} ${d.orderId}</div>
<div class="row">
    <span>Date: ${d.dateStr}</span>
</div>
<div class="row">
    <span>Cashier: ${d.cashierName}</span>
</div>
${d.servedBy ? `<div class="row" style="font-weight:bold;"><span>Served by: ${d.servedBy}</span></div>` : ""}

<div class="divider"></div>

<!-- Items -->
<table>
    <thead>
        <tr>
            <th style="text-align:left; width:40%;">Item</th>
            <th style="text-align:left; width:10%;">Qty</th>
            <th style="text-align:left; width:50%;">Amount</th>
        </tr>
    </thead>
    <tbody>${itemRows}</tbody>
</table>

<div class="divider"></div>

<!-- Totals -->
<div class="row"><span>Subtotal:</span><span>${fmtUGX(d.sub)}</span></div>
${conditionalRows}
<div class="divider-solid"></div>
<div class="total-row"><span>TOTAL:</span><span>${fmtUGX(d.total)}</span></div>

<div class="divider"></div>

<!-- Payment -->
<div class="row"><span>Payment:</span><strong>${d.paymentMethod}</strong></div>
<div class="row"><span>Paid:</span><span>${fmtUGX(d.paid)}</span></div>
${deliveryBlock}

<!-- Footer -->
<div class="footer">
    <div class="bold">Thank you for your business!</div>
    <div style="font-size:8pt; font-style:italic; margin-top:3px;">Powered by Jomish Business Suite</div>
</div>

</body>
</html>`;
}

function _printHTMLQueue(htmlArray) {
  if (htmlArray.length === 0) return;
  const html = htmlArray.shift();

  // Remove old iframe if it exists to keep DOM clean
  let oldFrame = document.getElementById("print-iframe");
  if (oldFrame) oldFrame.remove();

  const iframe = document.createElement("iframe");
  iframe.id = "print-iframe";
  iframe.className = "print-iframe-queue";
  iframe.style.cssText = "position:absolute;width:0;height:0;border:none;left:-9999px;top:-9999px;";
  document.body.appendChild(iframe);

  let printTriggered = false;
  let nextFired = false;

  const triggerNext = () => {
    if (nextFired) return;
    nextFired = true;
    setTimeout(() => {
      if (document.body.contains(iframe)) iframe.remove();
    }, 1200);
    _printHTMLQueue(htmlArray); // recursively print the next
  };

  const doPrintOnce = () => {
    if (printTriggered) return;
    printTriggered = true;
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      console.warn("Print execution error:", e);
    }

    if ("onafterprint" in iframe.contentWindow) {
      iframe.contentWindow.addEventListener("afterprint", triggerNext, { once: true });
    }
    setTimeout(triggerNext, 3000);
  };

  iframe.onload = doPrintOnce;

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();

  // Failsafe in case doc.close() finished immediately and onload did not fire
  setTimeout(() => {
    if (!printTriggered) doPrintOnce();
  }, 250);
}

/**
 * Trigger window.print() via a hidden iframe to avoid popup blockers and freezing.
 * This is the ONLY print path — clean, reliable, works on every device.
 */
function doPrint() {
  const d = _currentReceiptData;
  if (!d) {
    showToast("No receipt data to print.", "error");
    return;
  }

  const queue = [];
  
  if (d.printTokenOnly) {
    queue.push(_buildKitchenTokenHTML(d));
  } else {
    queue.push(_buildReceiptHTML(d));
  }
  
  _printHTMLQueue(queue);

  if (d.orderId) {
    _printedReceiptNos.add(Number(d.orderId));
  }

  const printBtn = document.getElementById("btn-do-print");
  if (printBtn) {
    printBtn.disabled = true;
    printBtn.style.opacity = "0.4";
    printBtn.style.pointerEvents = "none";
    printBtn.innerHTML = '<i class="fa-solid fa-check"></i> Printed';
  }
}

// ==== HARDWARE TEST PRINT FUNCTIONS ====

function testPrintReceipt() {
  const testItems = [
    { name: "Bread (Large)", price: 8000, qty: 2 },
    { name: "Milk 500ml", price: 3500, qty: 1 },
    { name: "Test Product", price: 12000, qty: 1 },
  ];
  const total = testItems.reduce((s, i) => s + i.price * i.qty, 0);
  printReceipt(testItems, total, 9999, "CASH", total);
  showToast("Test receipt generated — click Print in the modal.", "success");
}

function testPrintLabel() {
  printProductLabelsRange("TEST PRODUCT", 100001, 100001, 5000);
  showToast("1 test barcode sticker generated (38×25mm)", "success");
}

function testPrintID() {
  const testEmp = {
    id: 0,
    first_name: "Test",
    last_name: "Employee",
    role: "Staff Member",
    employee_code: "TEST-001",
    photo_base64: null,
  };
  generateIDCard(testEmp);
  showToast("Test ID card printed (85.6×54mm CR80)", "success");
}

// ==== OTHER HELPERS ====

async function handleAddSchedule(e) {
  // Legacy handler — the new override modal (openShiftModal) handles all assignments.
  // This stub prevents errors from the old listener binding.
  if (e) e.preventDefault();
  showToast("Use the Shift Timetable tab to assign shifts.", "info");
}

async function loadRoles() {
  try {
    const res = await fetchAuth(`${API_URL}/roles`);
    const data = await res.json();
    const tbody = document.querySelector("#roles-table tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    data.roles.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td style="font-weight:bold;">
                    ${r.role_name}
                    <button class="icon-btn action-btn" onclick="promptSetRolePassword('${r.role_name}')" title="Set Portal Password for this Role" style="margin-left: 8px; font-size: 0.8rem; padding: 2px 6px;">
                        <i class="fa-solid fa-key"></i>
                    </button>
                </td>
                <td><input type="checkbox" ${r.can_see_dashboard ? "checked" : ""} onchange="updateRole('${r.role_name}', 'dashboard', this.checked)"></td>
                <td><input type="checkbox" ${r.can_see_hr ? "checked" : ""} onchange="updateRole('${r.role_name}', 'hr', this.checked)"></td>
                <td><input type="checkbox" ${r.can_see_attendance ? "checked" : ""} onchange="updateRole('${r.role_name}', 'attendance', this.checked)"></td>
                <td><input type="checkbox" ${r.can_see_sme ? "checked" : ""} onchange="updateRole('${r.role_name}', 'sme', this.checked)"></td>
                <td><input type="checkbox" ${r.can_see_pos ? "checked" : ""} onchange="updateRole('${r.role_name}', 'pos', this.checked)"></td>
                <td><input type="checkbox" ${r.can_see_secretary ? "checked" : ""} onchange="updateRole('${r.role_name}', 'secretary', this.checked)"></td>
                <td><input type="checkbox" ${r.can_see_transport ? "checked" : ""} onchange="updateRole('${r.role_name}', 'transport', this.checked)"></td>
                <td><input type="checkbox" ${r.can_see_hardware ? "checked" : ""} onchange="updateRole('${r.role_name}', 'hardware', this.checked)"></td>
                <td><input type="checkbox" ${r.can_see_system_users ? "checked" : ""} onchange="updateRole('${r.role_name}', 'system_users', this.checked)"></td>
                <td><input type="checkbox" ${r.can_see_schedules ? "checked" : ""} onchange="updateRole('${r.role_name}', 'schedules', this.checked)"></td>`;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error(e);
  }
}

async function promptAddRole() {
  const roleName = prompt("Enter the new role name:");
  if (!roleName || !roleName.trim()) return;

  try {
    const res = await fetchAuth(`${API_URL}/roles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: roleName.trim() }),
    });
    if (res.ok) {
      showToast(`Role '${roleName}' created successfully!`, "success");
      loadRoles();
      // Try to refresh the select dropdown in the modal if it's visible
      loadRolesIntoSelect("emp-role", roleName.trim());
    } else {
      const data = await res.json();
      showToast(data.error || "Failed to create role", "danger");
    }
  } catch (e) {
    showToast("Network error while creating role.", "danger");
  }
}

// Pending role name — stored while waiting for password to be set
let _pendingRoleChange = null;

async function updateRole(roleName, module, isChecked) {
  const tbody = document.querySelector("#roles-table tbody");
  let row;
  for (let tr of tbody.children) {
    if (tr.children[0].innerText === roleName) {
      row = tr;
      break;
    }
  }
  if (!row) return;

  // 1. Collect current checkbox state and save permissions immediately
  const payload = {
    can_see_dashboard: row.children[1].querySelector("input").checked ? 1 : 0,
    can_see_hr: row.children[2].querySelector("input").checked ? 1 : 0,
    can_see_attendance: row.children[3].querySelector("input").checked ? 1 : 0,
    can_see_sme: row.children[4].querySelector("input").checked ? 1 : 0,
    can_see_pos: row.children[5].querySelector("input").checked ? 1 : 0,
    can_see_secretary: row.children[6].querySelector("input").checked ? 1 : 0,
    can_see_transport: row.children[7].querySelector("input").checked ? 1 : 0,
    can_see_hardware: row.children[8].querySelector("input").checked ? 1 : 0,
    can_see_system_users: row.children[9].querySelector("input").checked
      ? 1
      : 0,
    can_see_schedules: row.children[10].querySelector("input").checked ? 1 : 0,
  };

  try {
    await fetchAuth(`${API_URL}/roles/${roleName}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    showToast(`✅ Permissions for '${roleName}' updated!`, "success");
  } catch (e) {
    showToast("Failed to update role permissions.", "error");
    return;
  }
}

// New dedicated function to reset passwords for an entire role
window.promptSetRolePassword = function (roleName) {
  _pendingRoleChange = roleName;
  document.getElementById("confirm-pwd-desc").textContent =
    `Set the portal login password for all "${roleName}" users. They will use this to sign in.`;
  document.getElementById("confirm-pwd-input").value = "";
  document.getElementById("confirm-pwd-input").type = "password";
  document.getElementById("confirm-pwd-input").placeholder =
    "Type new portal password…";
  document.getElementById("confirm-pwd-error").style.display = "none";
  document.querySelector("#confirm-password-modal h3").innerHTML =
    '<i class="fa-solid fa-key"></i> Set Portal Password';
  document.getElementById("confirm-password-modal").classList.remove("hidden");
  setTimeout(() => document.getElementById("confirm-pwd-input").focus(), 100);
};

async function submitConfirmPassword() {
  const pwd = document.getElementById("confirm-pwd-input").value.trim();
  const errEl = document.getElementById("confirm-pwd-error");
  if (!pwd) {
    errEl.textContent = "Please enter a password.";
    errEl.style.display = "block";
    return;
  }

  const roleName = _pendingRoleChange;
  if (!roleName) {
    document.getElementById("confirm-password-modal").classList.add("hidden");
    return;
  }

  try {
    const res = await fetchAuth(
      `${API_URL}/roles/${encodeURIComponent(roleName)}/password`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwd }),
      },
    );
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || "Failed to set password.";
      errEl.style.display = "block";
      return;
    }

    document.getElementById("confirm-password-modal").classList.add("hidden");
    _pendingRoleChange = null;
    showToast(`🔑 ${data.message}`, "success");
  } catch (e) {
    showToast("Failed to set portal password.", "error");
  }
}

async function loadBrandLogo() {
  try {
    const res = await fetchAuth(`${API_URL}/settings/all`);
    const data = await res.json();

    // ─── GLOBAL TECH MODE ───────────────────────────────────────────────
    // When logged in as 'tech' (no company prefix), hide ALL company branding.
    // The global tech is a Jomish system account and must not see any company data.
    if (data._is_global_tech) {
      // Hide every company logo
      document.querySelectorAll(".global-logo").forEach((img) => {
        img.src = "";
        img.style.display = "none";
      });

      // Set sidebar brand to generic Jomish label
      const sideBrand = document.getElementById("sidebar-brand-name");
      if (sideBrand) {
        sideBrand.innerText = "Jomish Suite";
        sideBrand.style.display = "";
      }

      // Set dashboard header to generic label
      const dashHeader = document.querySelector("#dashboard header h1");
      if (dashHeader) dashHeader.innerText = "Jomish Business Suite";

      // Hide the receipt brand (receipts belong to companies, not global tech)
      const rBrand = document.getElementById("receipt-brand");
      if (rBrand) rBrand.innerText = "Jomish";

      // Clear any stale company name from previous login
      localStorage.removeItem("jomish_biz_name");
      localStorage.removeItem("jomish_biz_location");
      localStorage.removeItem("jomish_biz_contact");
      localStorage.removeItem("jomish_biz_color");
      localStorage.removeItem("jomish_emp_prefix");

      enforceRBAC();
      return; // Don't apply any company-specific settings
    }
    // ─── END GLOBAL TECH MODE ───────────────────────────────────────────

    // Apply Logo
    if (data.company_logo) {
      document.querySelectorAll(".global-logo").forEach((img) => {
        img.src = data.company_logo;
        img.style.display = "block";
      });
    }

    // Apply Business Name
    if (data.business_name) {
      const bizName = data.business_name;
      localStorage.setItem("jomish_biz_name", bizName);
      // Sidebar - reveal company brand after login
      const sideBrand = document.getElementById("sidebar-brand-name");
      if (sideBrand) {
        sideBrand.innerText = bizName;
        sideBrand.style.display = "";
      }
      // (Legacy selector fallback)
      const sideBrandLegacy = document.querySelector(
        ".brand h2:not(#sidebar-brand-name)",
      );
      if (sideBrandLegacy) sideBrandLegacy.innerText = bizName;

      // Dashboard Header
      const dashHeader = document.querySelector("#dashboard header h1");
      if (dashHeader) dashHeader.innerText = bizName + " Hub";

      // Receipt Header
      const rBrand = document.getElementById("receipt-brand");
      if (rBrand) rBrand.innerText = bizName.toUpperCase();

      // ID Card Header
      const idBrand = document.getElementById("id-biz-name-front");
      if (idBrand) idBrand.innerText = bizName.toUpperCase();

      // Populate Input if on screen
      const bizInput = document.getElementById("business-name-input");
      if (bizInput) bizInput.value = bizName;
    }

    // Apply Other Business Settings
    if (data.business_location) {
      localStorage.setItem("jomish_biz_location", data.business_location);
      const locInput = document.getElementById("business-location-input");
      if (locInput) locInput.value = data.business_location;
    }
    if (data.business_contact) {
      localStorage.setItem("jomish_biz_contact", data.business_contact);
      const conInput = document.getElementById("business-contact-input");
      if (conInput) conInput.value = data.business_contact;
    }
    if (data.business_color) {
      localStorage.setItem("jomish_biz_color", data.business_color);
      const colorInput = document.getElementById("business-color-input");
      if (colorInput) colorInput.value = data.business_color;
    }
    if (data.emp_prefix) {
      localStorage.setItem("jomish_emp_prefix", data.emp_prefix);
      const prefixInput = document.getElementById("business-emp-prefix-input");
      if (prefixInput) prefixInput.value = data.emp_prefix;
    }

    const brandColor = localStorage.getItem("jomish_biz_color") || "#4F46E5";
    const frontCard = document.getElementById("id-card-front");
    const backCard = document.getElementById("id-card-back");
    if (frontCard) frontCard.style.setProperty("--brand-id-color", brandColor);
    if (backCard) backCard.style.setProperty("--brand-id-color", brandColor);

    // Apply Module Visibility Configuration
    if (data.business_modules) {
      try {
        const modules =
          typeof data.business_modules === "string"
            ? JSON.parse(data.business_modules)
            : data.business_modules;
        Object.assign(ENABLED_TABS, modules);

        // Populate checkboxes if elements exist
        [
          "dashboard",
          "hr",
          "attendance",
          "sme",
          "pos",
          "secretary",
          "transport",
          "schedules",
          "hardware",
        ].forEach((m) => {
          const cb = document.getElementById(`mod-${m}`);
          if (cb && modules[m] !== undefined) cb.checked = !!modules[m];
        });
        const cbSysUser = document.getElementById("mod-system-users");
        if (cbSysUser && modules.system_users !== undefined)
          cbSysUser.checked = !!modules.system_users;
      } catch (e) {
        console.error("Failed to parse business_modules setting", e);
      }
    }

    if (data.global_shifts) {
      try {
        const s =
          typeof data.global_shifts === "string"
            ? JSON.parse(data.global_shifts)
            : data.global_shifts;
        if (Array.isArray(s) && s.length > 0) {
          GLOBAL_SHIFTS = s;
        }
      } catch (e) {
        console.error("Failed to parse global_shifts", e);
      }
    }
    if (data.global_operational_days) {
      try {
        const d =
          typeof data.global_operational_days === "string"
            ? JSON.parse(data.global_operational_days)
            : data.global_operational_days;
        if (Array.isArray(d)) {
          GLOBAL_OPERATIONAL_DAYS = d;
        }
      } catch (e) {
        console.error("Failed to parse global_operational_days", e);
      }
    }

    // Populate days UI
    document.querySelectorAll("#tech-shift-days input").forEach((i) => {
      i.checked = GLOBAL_OPERATIONAL_DAYS.includes(i.value);
    });

    renderTechShifts();
    enforceRBAC();
  } catch (e) {
    console.error(e);
  }
}

async function handleLogoUpload() {
  const input = document.getElementById("upload-logo-input");
  if (!input.files || input.files.length === 0) return alert("Select file");
  const file = input.files[0];
  const reader = new FileReader();
  reader.onload = async (e) => {
    const res = await fetchAuth(`${API_URL}/settings/logo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logo_base64: e.target.result }),
    });
    if (res.ok) {
      showToast("Logo Updated Everywhere!", "success");
      loadBrandLogo();
    } else {
      const data = await res.json();
      showToast("Error: " + (data.error || "Could not upload logo"), "danger");
    }
  };
  reader.readAsDataURL(file);
}

async function handleDetailsUpdate() {
  const name = document.getElementById("business-name-input").value;
  const location = document.getElementById("business-location-input").value;
  const contact = document.getElementById("business-contact-input").value;
  const color = document.getElementById("business-color-input").value;
  const empPrefix = document.getElementById("business-emp-prefix-input").value;

  const res = await fetchAuth(`${API_URL}/settings/details`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      business_name: name,
      business_location: location,
      business_contact: contact,
      business_color: color,
      emp_prefix: empPrefix,
    }),
  });
  if (res.ok) {
    showToast("Business Details & Color Updated Successfully!", "success");
    loadBrandLogo();
  } else {
    const data = await res.json();
    showToast("Error: " + (data.error || "Could not save details"), "danger");
  }
}

async function handleSaveModulesUpdate() {
  const btn = document.getElementById("btn-save-modules");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving...";
  }

  const modules = {
    dashboard: document.getElementById("mod-dashboard").checked,
    hr: document.getElementById("mod-hr").checked,
    attendance: document.getElementById("mod-attendance").checked,
    sme: document.getElementById("mod-sme").checked,
    pos: document.getElementById("mod-pos").checked,
    secretary: document.getElementById("mod-secretary").checked,
    transport: document.getElementById("mod-transport")
      ? document.getElementById("mod-transport").checked
      : true,
    schedules: document.getElementById("mod-schedules")
      ? document.getElementById("mod-schedules").checked
      : true,
    hardware: document.getElementById("mod-hardware")
      ? document.getElementById("mod-hardware").checked
      : true,
    system_users: document.getElementById("mod-system-users")
      ? document.getElementById("mod-system-users").checked
      : true,
  };

  try {
    const res = await fetchAuth(`${API_URL}/settings`, {
      method: "POST",
      body: JSON.stringify({
        key: "business_modules",
        data: modules,
      }),
    });

    if (res.ok) {
      alert("Custom Active Tabs Saved Successfully!");
      // Immediate local update
      Object.assign(ENABLED_TABS, modules);
      enforceRBAC();
    } else {
      const data = await res.json();
      alert("Error: " + (data.error || "Failed to save configuration."));
    }
  } catch (err) {
    console.error("Modules Update Error:", err);
    alert("Network Error. Please check server connection.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save Custom Active Tabs";
    }
  }
}

function renderTechShifts() {
  const container = document.getElementById("tech-shifts-container");
  if (!container) return;
  container.innerHTML = "";
  GLOBAL_SHIFTS.forEach((shift, idx) => {
    container.innerHTML += `
            <div style="display:flex; gap:10px; align-items:center; background:var(--background); padding:10px; border-radius:8px; border:1px solid var(--border);">
                <input type="text" id="tech-shift-label-${idx}" value="${shift.label}" class="form-control" style="flex:2" placeholder="Shift Name (e.g. Day)">
                <input type="time" id="tech-shift-start-${idx}" value="${shift.start_time || "00:00"}" class="form-control" style="flex:1">
                <span style="color:#94A3B8">to</span>
                <input type="time" id="tech-shift-end-${idx}" value="${shift.end_time || "00:00"}" class="form-control" style="flex:1">
                <button class="secondary-btn" onclick="removeTechShift(${idx})" style="color:var(--danger); border-color:transparent;"><i class="fa-solid fa-trash"></i></button>
            </div>
        `;
  });
}

window.addTechShift = function () {
  GLOBAL_SHIFTS.push({
    id: "shift_" + Date.now(),
    label: "New Shift",
    icon: "fa-solid fa-clock",
    color: "#6366F1",
    start_time: "08:00",
    end_time: "17:00",
  });
  renderTechShifts();
};

window.removeTechShift = function (idx) {
  GLOBAL_SHIFTS.splice(idx, 1);
  renderTechShifts();
};

window.saveTechShifts = async function () {
  for (let i = 0; i < GLOBAL_SHIFTS.length; i++) {
    const label =
      document.getElementById("tech-shift-label-" + i).value || "Shift " + i;
    GLOBAL_SHIFTS[i].label = label;
    GLOBAL_SHIFTS[i].id = label.toLowerCase().replace(/[^a-z0-9]/g, "");
    GLOBAL_SHIFTS[i].start_time =
      document.getElementById("tech-shift-start-" + i).value || "00:00";
    GLOBAL_SHIFTS[i].end_time =
      document.getElementById("tech-shift-end-" + i).value || "00:00";
  }

  GLOBAL_OPERATIONAL_DAYS = Array.from(
    document.querySelectorAll("#tech-shift-days input:checked"),
  ).map((i) => i.value);

  try {
    const res1 = await fetchAuth(`${API_URL}/settings`, {
      method: "POST",
      body: JSON.stringify({ key: "global_shifts", data: GLOBAL_SHIFTS }),
    });
    const res2 = await fetchAuth(`${API_URL}/settings`, {
      method: "POST",
      body: JSON.stringify({
        key: "global_operational_days",
        data: GLOBAL_OPERATIONAL_DAYS,
      }),
    });
    if (res1.ok && res2.ok) {
      showToast("Shift Configuration Saved!", "success");
      if (window.loadShiftTimetable) window.loadShiftTimetable(); // refresh UI if active
    } else {
      alert("Failed to save shifts or days.");
    }
  } catch (e) {
    console.error(e);
    alert("Error saving shifts");
  }
};

async function loadAttendance() {

  // 1. Load History Logs (Independent Catch)
  try {
    const res = await fetchAuth(`${API_URL}/attendance`);
    const data = await res.json();
    const tbody = document.querySelector("#attendance-table tbody");
    if (tbody) {
      tbody.innerHTML = "";
      data.attendance.forEach((log) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>SCAN-${log.id}</td><td>${log.first_name} ${log.last_name}</td><td>${formatDisplayDate(log.scan_time, true)}</td><td>${log.scan_type}</td><td style="color: ${log.scan_type === "IN" ? "var(--success)" : "var(--danger)"}; font-weight:bold;">${log.scan_type}</td>`;
        tbody.appendChild(tr);
      });
    }
  } catch (e) {
    console.error("History Log Error:", e);
  }

  // 2. Load Present Staff (Independent Catch)
  try {
    const presRes = await fetchAuth(`${API_URL}/attendance/present`);
    const presData = await presRes.json();

    const pTbody = document.querySelector("#present-staff-table tbody");
    if (pTbody) {
      pTbody.innerHTML = "";
      const present = presData.present_staff || [];
      if (present.length === 0) {
        pTbody.innerHTML =
          '<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--text-muted);">No staff currently in building.</td></tr>';
      } else {
        present.forEach((e) => {
          const tr = document.createElement("tr");
          let timeStr = "Recently";
          if (e.login_time) {
            try {
              const date = new Date(e.login_time);
              if (!isNaN(date.getTime())) {
                timeStr = date.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });
              }
            } catch (err) {}
          }

          tr.innerHTML = `
                        <td><strong>${e.first_name} ${e.last_name}</strong></td>
                        <td>${e.role}</td>
                        <td style="color:var(--primary); font-weight:bold;">${timeStr}</td>
                        <td><button class="sm-btn danger" onclick="clockOutStaff(${e.id})">Clock Out</button></td>
                    `;
          pTbody.appendChild(tr);
        });
      }
    } else {
      console.error(
        "Attendance: Table #present-staff-table tbody not found in DOM!",
      );
    }
  } catch (e) {
    console.error("Presence Monitoring Error:", e);
  }
}

async function downloadAttendancePDF() {
  try {
    const { jsPDF } = window.jspdf;
    const res = await fetchAuth(`${API_URL}/attendance`);
    const data = await res.json();

    const doc = new jsPDF();

    // Header
    doc.setFontSize(22);
    doc.text("Jomish Business Suite", 14, 20);
    doc.setFontSize(12);
    doc.setTextColor(100);
    doc.text("Employee Attendance History Report", 14, 30);
    doc.text(`Generated on: ${new Date().toLocaleString()}`, 14, 37);

    // Table
    const columns = ["ID", "Staff Name", "Date & Time", "Action", "Status"];
    const rows = data.attendance.map((log) => [
      `SCAN-${log.id}`,
      `${log.first_name} ${log.last_name}`,
      new Date(log.scan_time).toLocaleString(),
      log.scan_type,
      log.status,
    ]);

    doc.autoTable({
      startY: 45,
      head: [columns],
      body: rows,
      theme: "striped",
      headStyles: { fillColor: [79, 70, 229] }, // Jomish Indigo
    });

    doc.save(`Attendance_Report_${new Date().toISOString().split("T")[0]}.pdf`);
  } catch (e) {
    console.error(e);
    alert("Failed to generate PDF. Make sure you are connected.");
  }
}

async function loadTransactions(searchTerm = "") {
  try {
    const res = await fetchAuth(`${API_URL}/transactions?t=${Date.now()}&force_refresh=true`);
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const err = await res.json();
        errMsg = err.error || errMsg;
      } catch (e) {}
      console.error("TX Load Error:", errMsg);
      showToast("Failed to load transactions: " + errMsg, "danger");
      return;
    }
    const data = await res.json();
    if (!data || !Array.isArray(data.transactions)) {
      console.error("TX Load: unexpected response format", data);
      return;
    }
    const tbody = document.querySelector("#transactions-table tbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    let filtered = data.transactions;
    if (searchTerm) {
      // Strip known document prefixes so '002' matches 'RCPT002', 'INV002', etc.
      const term = searchTerm.trim().toLowerCase().replace(/^(rcpt|inv|ref|tx|exp)0*/i, "");
      const rawTerm = searchTerm.trim().toLowerCase();
      filtered = filtered.filter((tx) => {
        const rcptNo = String(tx.receipt_no || tx.id);
        const invNo = tx.order_invoice_number ? String(tx.order_invoice_number) : "";
        const paddedNo = String(tx.id).padStart(4, "0");
        const strippedRcpt = rcptNo.replace(/^(rcpt|ref|tx|exp)0*/i, "");
        const strippedInv = invNo.replace(/^inv0*/i, "");
        return (
          paddedNo.includes(term) ||
          strippedRcpt.includes(term) ||
          strippedInv.includes(term) ||
          String(tx.id).includes(term) ||
          (tx.description || "").toLowerCase().includes(rawTerm)
        );
      });
    }

    if (filtered.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="7" style="text-align:center; padding:20px; color:var(--text-muted);">No records found.</td></tr>';
      return;
    }

    filtered.forEach((tx) => {
      const isIncome = tx.type === "INCOME" || tx.type === "CASH_IN" || tx.type === "FLOAT_IN";
      const color = isIncome ? "var(--success)" : "var(--danger)";
      const receiptNo = formatDocNo("RCPT", tx.receipt_no || tx.id);
      const invBadge = tx.order_invoice_number
        ? `<span style="font-size:0.75rem; color:var(--text-muted); margin-left:4px; font-weight:normal;" title="Linked Invoice">(Inv: ${formatDocNo("INV", tx.order_invoice_number)})</span>`
        : "";
      const tr = document.createElement("tr");

      // ── Action badge: real-time payment status + method ──
      const _desc = (tx.description || "").toLowerCase();
      const _payStatus = (tx.payment_status || "").toUpperCase();
      const _payMethod = (tx.order_payment_method || "").toUpperCase();
      const _isPending =
        _payStatus.includes("PENDING") ||
        _desc.includes("pending") ||
        ((_payMethod === "COD" || _payMethod === "INVOICE") && _payStatus !== "PAID") ||
        (tx.order_amount_paid !== null && tx.order_amount_paid !== undefined && Number(tx.order_amount_paid) < Number(tx.order_total_amount || 0) && _payStatus !== "PAID");

      let _badge = "", _bColor = "";

      if (tx.type === "GOODS_ON_CREDIT") {
        _badge = "🔖 Credit Sale"; _bColor = "#f59e0b";
      } else if ((_desc.includes("credit") || _desc.includes("creditor")) && (_desc.includes("paid") || _desc.includes("payment"))) {
        _badge = "✅ Credit Paid"; _bColor = "#10b981";
      } else if (tx.type === "CASH_IN" || tx.type === "FLOAT_IN") {
        _badge = "📥 Cash In (Float)"; _bColor = "#10b981";
      } else if (tx.type === "EXPENSE") {
        _badge = "💸 Expense"; _bColor = "#ef4444";
      } else if (_isPending) {
        _badge = "⏳ Pending"; _bColor = "#f59e0b";
      } else if (tx.type === "INCOME" || tx.type === "PAYMENT") {
        // Paid order — show payment method
        if (
          _payMethod === "MOBILE MONEY" ||
          _payMethod === "MOMO" ||
          _desc.includes("mobile") ||
          _desc.includes("momo") ||
          _desc.includes("airtel") ||
          _desc.includes("mtn")
        ) {
          _badge = "📱 Mobile Money"; _bColor = "#6366f1";
        } else if (
          _payMethod === "BANK" ||
          _payMethod.includes("TRANSFER") ||
          _desc.includes("bank") ||
          _desc.includes("transfer")
        ) {
          _badge = "🏦 Bank Transfer"; _bColor = "#3b82f6";
        } else {
          _badge = "💵 Cash Payment"; _bColor = "#10b981";
        }
      } else {
        _badge = "📋 Manual Entry"; _bColor = "#64748b";
      }
      const _badgeHtml = `<span style="display:inline-block;padding:3px 9px;border-radius:20px;background:${_bColor}22;color:${_bColor};font-size:0.72rem;font-weight:700;border:1px solid ${_bColor}55;white-space:nowrap;">${_badge}</span>`;

      // Delete + Print Invoice buttons: only visible for Admin/HR/CEO/Manager
      // Cashiers can delete ONLY by selecting the row and pressing F8
      const _role = (USER_ROLE || "").toUpperCase();
      const canDeleteDirectly = ["CEO", "ADMIN", "HR", "MANAGER", "SUPERVISOR"].includes(_role) || USER_NAME === "System Technician" || _role === "TECH";
      const _printInvBtn = (canDeleteDirectly && tx.type === "INCOME" && tx.pos_order_id)
        ? `<button class='sm-btn secondary' onclick="printTransactionInvoice(${tx.pos_order_id})" style="padding:3px 8px;font-size:0.72rem;margin-left:4px;" title="Print Invoice"><i class="fa-solid fa-print"></i></button>`
        : "";
      const _delBtn = canDeleteDirectly
        ? `<button class='sm-btn danger' onclick="deleteTransaction(${tx.id})" style="padding:3px 8px;font-size:0.72rem;margin-left:4px;" title="Delete"><i class="fa-solid fa-trash"></i></button>`
        : "";
      const actionHtml = `<td style="white-space:nowrap;">${_badgeHtml}${_printInvBtn}${_delBtn}</td>`;

      let displayType = tx.type;
      if (tx.type === "GOODS_ON_CREDIT") displayType = "GOODS ON CREDIT";

      const cashierName = tx.recorded_by_name || "—";

      let descText = tx.description || "";
      if (/^Credit payment from (.+)$/i.test(descText)) {
        descText = descText.replace(/^Credit payment from (.+)$/i, "Credit payment: $1 paid");
      }

      tr.innerHTML = `<td><a href="#" onclick="viewReceiptDetails(${tx.id}); return false;" style="color:var(--primary); font-weight:bold; text-decoration:none;">${receiptNo}</a>${invBadge}</td><td>${formatDisplayDate(tx.transaction_date, true)}</td><td style="color: ${color}; font-weight: bold;">${isIncome ? "+" : "-"}UGX ${Number(tx.amount || 0).toLocaleString()}</td><td>${displayType}</td><td>${descText}</td><td>${cashierName}</td>${actionHtml}`;
      tr.dataset.txId = tx.id;
      tr.setAttribute("data-tx-id", tx.id);
      tr.style.cursor = "pointer";
      tr.addEventListener("click", function(e) {
        if (e.target.closest("button")) return;
        if (typeof window.selectTxRow === "function") {
          window.selectTxRow(tr);
        }
      });
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error("TX Network Error:", e);
  }
}

window.printTransactionInvoice = async function (posOrderId) {
  try {
    showToast("Loading invoice details...", "info");
    const r = await fetchAuth(`${API_URL}/pos_orders/${posOrderId}`);
    if (!r.ok) {
      showToast("Order not found", "error");
      return;
    }
    const o = await r.json();
    await printPendingInvoice(
      posOrderId,
      o.total_amount,
      o.buyer_name || "Customer",
      o.served_by || "Staff",
      o.invoice_number
    );
  } catch (e) {
    console.error("Error printing transaction invoice:", e);
    showToast("Error printing invoice", "error");
  }
};

let _allSmeProducts = [];

function toggleSmeView(view) {
  const txView = document.getElementById("sme-view-transactions");
  const repView = document.getElementById("sme-view-reports");
  const prodView = document.getElementById("sme-view-products");
  const invView = document.getElementById("sme-view-invoices");
  const archView = document.getElementById("sme-view-archives");

  if (txView) txView.style.display = "none";
  if (repView) repView.style.display = "none";
  if (prodView) prodView.style.display = "none";
  if (invView) invView.style.display = "none";
  if (archView) archView.style.display = "none";

  if (view === "transactions") {
    if (txView) txView.style.display = "block";
  } else if (view === "reports") {
    if (repView) repView.style.display = "block";
    populateCashierSelect();
  } else if (view === "products") {
    if (prodView) prodView.style.display = "block";
    loadSmeProductSales();
  } else if (view === "invoices") {
    if (invView) invView.style.display = "block";
    loadCustomerInvoices();
  } else if (view === "archives") {
    if (archView) archView.style.display = "block";
    loadArchiveManager();
  }
}

async function loadArchiveManager() {
  const tbody = document.getElementById("archives-tbody");
  const lastEl = document.getElementById("archive-status-last");
  const nextEl = document.getElementById("archive-status-next");

  try {
    const [statusRes, listRes] = await Promise.all([
      fetchAuth(`${API_URL}/archives/status`).then(r => r.json()).catch(() => ({})),
      fetchAuth(`${API_URL}/archives`).then(r => r.json()).catch(() => ({ archives: [] }))
    ]);

    if (lastEl) {
      lastEl.textContent = statusRes.last_archive
        ? formatDisplayDate(statusRes.last_archive, true)
        : "Pending first cycle";
    }
    if (nextEl) {
      nextEl.textContent = statusRes.next_archive
        ? formatDisplayDate(statusRes.next_archive, true)
        : "Scheduled in next cycle";
    }

    if (!tbody) return;
    const archives = listRes.archives || [];
    if (archives.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:30px; color:var(--text-muted);"><i class="fa-solid fa-folder-open"></i> No PDF archives generated yet. Archives will appear here every 2 months.</td></tr>';
      return;
    }

    tbody.innerHTML = archives.map(a => `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="font-weight:600; padding:10px 8px; color:var(--primary); font-family:monospace;">
          <i class="fa-solid fa-file-pdf" style="color:#ef4444; margin-right:6px;"></i>${a.filename}
        </td>
        <td style="padding:10px 8px; font-size:0.85rem;">${formatDisplayDate(a.createdAt, true)}</td>
        <td style="padding:10px 8px; font-size:0.85rem; color:var(--text-muted);">${a.sizeFormatted}</td>
        <td style="padding:10px 8px; text-align:right;">
          <a href="${API_URL}/archives/download/${encodeURIComponent(a.filename)}" download class="sm-btn primary" style="padding:5px 12px; font-size:0.8rem; text-decoration:none; display:inline-block;" target="_blank">
            <i class="fa-solid fa-download"></i> Download PDF
          </a>
        </td>
      </tr>
    `).join("");

  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--danger);">Error loading archives: ${err.message}</td></tr>`;
  }
}

async function triggerManualArchive() {
  const btn = document.getElementById("btn-manual-archive");
  if (!confirm("Are you sure you want to run the archival now?\n\nThis will:\n1. Generate a permanent PDF audit ledger of all completed transactions older than 3 weeks.\n2. Clear them from the database to optimize speed.\n3. Cleanly recycle receipt numbers for future sales.\n\nProceed?")) {
    return;
  }

  const origHtml = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Archiving to PDF...';
  }

  try {
    const res = await fetchAuth(`${API_URL}/archives/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ageDays: 21 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Archiving failed");

    showToast(data.message || `Archived ${data.count} transactions successfully!`, "success");
    loadArchiveManager();
    loadTransactions();
  } catch (err) {
    alert("Archival failed: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
}
window.loadArchiveManager = loadArchiveManager;
window.triggerManualArchive = triggerManualArchive;

async function loadSmeProductSales() {
  const tbody = document.getElementById("sme-products-tbody");
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:25px; color:var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Loading product sales counters...</td></tr>';

  try {
    if (window.OfflineDB && typeof window.OfflineDB.bustCache === "function") {
      await window.OfflineDB.bustCache("/reports/products-sold").catch(() => {});
      await window.OfflineDB.bustCache("/api/reports/products-sold").catch(() => {});
    }
    const res = await fetchAuth(`${API_URL}/reports/products-sold?force_refresh=true&_t=${Date.now()}`);
    const data = await res.json();
    _allSmeProducts = data.products || [];

    const totalSoldEl = document.getElementById("sme-total-sold-counter");
    const todaySoldEl = document.getElementById("sme-today-sold-counter");
    if (totalSoldEl) totalSoldEl.textContent = (data.totalItemsSold || 0).toLocaleString();
    if (todaySoldEl) todaySoldEl.textContent = (data.totalItemsSoldToday || 0).toLocaleString();

    // Populate category filter dropdown
    const catSelect = document.getElementById("sme-product-category-filter");
    if (catSelect) {
      const currentVal = catSelect.value;
      const categories = [...new Set(_allSmeProducts.map((p) => p.category || "General"))].sort();
      catSelect.innerHTML = '<option value="">All Categories</option>' +
        categories.map((c) => `<option value="${c}">${c}</option>`).join("");
      catSelect.value = currentVal;
    }

    renderSmeProductsTable(_allSmeProducts);
  } catch (err) {
    console.error("Failed to load SME product sales:", err);
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:20px; color:var(--danger);">Error loading product sales data.</td></tr>';
  }
}

function renderSmeProductsTable(products) {
  const tbody = document.getElementById("sme-products-tbody");
  if (!tbody) return;
  if (!products || products.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:25px; color:var(--text-muted);">No products found.</td></tr>';
    return;
  }

  const safe = (str) => String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  tbody.innerHTML = products.map((p) => {
    const totalSold = Number(p.total_sold) || 0;
    const soldToday = Number(p.sold_today) || 0;
    const rev = Number(p.total_revenue) || (totalSold * (Number(p.price) || 0));
    const statusText = p.track_stock === 0 ? '<span style="color:#8B5CF6; font-weight:700;"><i class="fa-solid fa-infinity"></i> Unlimited</span>' : `Stock: <strong>${p.stock}</strong>`;

    return `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:10px 12px; font-weight:600; color:var(--text);">${safe(p.name)}</td>
        <td style="padding:10px 12px;"><span class="badge" style="background:rgba(255,255,255,0.08); font-size:0.75rem;">${safe(p.category || "General")}</span></td>
        <td style="padding:10px 12px; text-align:right; font-weight:600;">UGX ${(p.price || 0).toLocaleString()}</td>
        <td style="padding:10px 12px; text-align:center;">
          <span style="background:rgba(16,185,129,0.12); color:#10B981; border:1px solid rgba(16,185,129,0.25); padding:3px 10px; border-radius:12px; font-weight:800; font-size:0.85rem;">
            ${totalSold.toLocaleString()}
          </span>
        </td>
        <td style="padding:10px 12px; text-align:center;">
          <span style="font-weight:700; color:${soldToday > 0 ? '#F59E0B' : 'var(--text-muted)'};">
            ${soldToday.toLocaleString()}
          </span>
        </td>
        <td style="padding:10px 12px; text-align:right; font-weight:700; color:var(--primary);">UGX ${rev.toLocaleString()}</td>
        <td style="padding:10px 12px; text-align:center; font-size:0.82rem;">${statusText}</td>
      </tr>
    `;
  }).join("");
}

function filterSmeProducts(optionalVal) {
  const inputEl = document.getElementById("sme-product-search");
  const query = (optionalVal !== undefined ? String(optionalVal) : (inputEl?.value || "")).trim().toLowerCase();
  const category = document.getElementById("sme-product-category-filter")?.value || "";

  const terms = query ? query.split(/\s+/).filter(Boolean) : [];

  const filtered = _allSmeProducts.filter((p) => {
    const pName = (p.name || "").toLowerCase();
    const pCat = (p.category || "").toLowerCase();
    const pBarcode = (p.barcode || "").toLowerCase();
    const pBarcodeEnd = (p.barcode_end || "").toLowerCase();

    const matchesName =
      terms.length === 0 ||
      terms.every(
        (t) =>
          pName.includes(t) ||
          pCat.includes(t) ||
          pBarcode.includes(t) ||
          pBarcodeEnd.includes(t)
      );
    const matchesCat = !category || p.category === category;
    return matchesName && matchesCat;
  });

  // Dynamically update the summary counters based on searched/filtered products
  let totalSoldFiltered = 0;
  let soldTodayFiltered = 0;
  filtered.forEach((p) => {
    totalSoldFiltered += Number(p.total_sold) || 0;
    soldTodayFiltered += Number(p.sold_today) || 0;
  });

  const totalSoldEl = document.getElementById("sme-total-sold-counter");
  const todaySoldEl = document.getElementById("sme-today-sold-counter");
  if (totalSoldEl) totalSoldEl.textContent = totalSoldFiltered.toLocaleString();
  if (todaySoldEl) todaySoldEl.textContent = soldTodayFiltered.toLocaleString();

  renderSmeProductsTable(filtered);
}

let _allModalProducts = [];

async function openProductSalesCounterModal() {
  const modal = document.getElementById("product-sales-counter-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  await fetchAndRenderProductSalesModal();
}

function closeProductSalesCounterModal() {
  const modal = document.getElementById("product-sales-counter-modal");
  if (modal) modal.classList.add("hidden");
}

async function fetchAndRenderProductSalesModal() {
  const tbody = document.getElementById("modal-product-sales-tbody");
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Loading product sales counters...</td></tr>';

  try {
    if (window.OfflineDB && typeof window.OfflineDB.bustCache === "function") {
      await window.OfflineDB.bustCache("/reports/products-sold").catch(() => {});
      await window.OfflineDB.bustCache("/api/reports/products-sold").catch(() => {});
    }
    const res = await fetchAuth(`${API_URL}/reports/products-sold?force_refresh=true&_t=${Date.now()}`);
    const data = await res.json();
    _allModalProducts = data.products || [];

    // Populate modal category filter
    const catSelect = document.getElementById("modal-product-category-filter");
    if (catSelect) {
      const currentVal = catSelect.value;
      const categories = [...new Set(_allModalProducts.map((p) => p.category || "General"))].sort();
      catSelect.innerHTML = '<option value="">All Categories</option>' +
        categories.map((c) => `<option value="${c}">${c}</option>`).join("");
      catSelect.value = currentVal;
    }

    renderModalProductSalesTable(_allModalProducts);
  } catch (err) {
    console.error("Modal Product Sales Error:", err);
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:20px; color:var(--danger);">Error loading sales data.</td></tr>';
  }
}

function renderModalProductSalesTable(products) {
  const tbody = document.getElementById("modal-product-sales-tbody");
  if (!tbody) return;
  if (!products || products.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--text-muted);">No products match filter.</td></tr>';
    return;
  }

  const safe = (str) => String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  tbody.innerHTML = products.map((p) => {
    const totalSold = Number(p.total_sold) || 0;
    const soldToday = Number(p.sold_today) || 0;
    const rev = Number(p.total_revenue) || (totalSold * (Number(p.price) || 0));
    const statusText = p.track_stock === 0 ? '<span style="color:#8B5CF6; font-weight:700;"><i class="fa-solid fa-infinity"></i> Unlimited</span>' : `Stock: <strong>${p.stock}</strong>`;

    return `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:10px; font-weight:600;">${safe(p.name)}</td>
        <td style="padding:10px;"><span class="badge" style="background:rgba(255,255,255,0.08); font-size:0.75rem;">${safe(p.category || "General")}</span></td>
        <td style="padding:10px; text-align:right;">UGX ${(p.price || 0).toLocaleString()}</td>
        <td style="padding:10px; text-align:center;">
          <span style="background:rgba(16,185,129,0.12); color:#10B981; border:1px solid rgba(16,185,129,0.25); padding:2px 8px; border-radius:12px; font-weight:800; font-size:0.85rem;">
            ${totalSold.toLocaleString()}
          </span>
        </td>
        <td style="padding:10px; text-align:center;">
          <span style="font-weight:700; color:${soldToday > 0 ? '#F59E0B' : 'var(--text-muted)'};">
            ${soldToday.toLocaleString()}
          </span>
        </td>
        <td style="padding:10px; text-align:right; font-weight:700; color:var(--primary);">UGX ${rev.toLocaleString()}</td>
        <td style="padding:10px; text-align:center; font-size:0.8rem;">${statusText}</td>
      </tr>
    `;
  }).join("");
}

function filterModalProductSales(optionalVal) {
  const inputEl = document.getElementById("modal-product-sales-search");
  const query = (optionalVal !== undefined ? String(optionalVal) : (inputEl?.value || "")).trim().toLowerCase();
  const category = document.getElementById("modal-product-category-filter")?.value || "";

  const terms = query ? query.split(/\s+/).filter(Boolean) : [];

  const filtered = _allModalProducts.filter((p) => {
    const pName = (p.name || "").toLowerCase();
    const pCat = (p.category || "").toLowerCase();
    const pBarcode = (p.barcode || "").toLowerCase();
    const matchesName =
      terms.length === 0 ||
      terms.every((t) => pName.includes(t) || pCat.includes(t) || pBarcode.includes(t));
    const matchesCat = !category || p.category === category;
    return matchesCat && matchesName;
  });

  renderModalProductSalesTable(filtered);
}


async function viewReceiptDetails(txId) {
  window._activeReceiptModalTxId = txId;
  try {
    const res = await fetchAuth(`${API_URL}/pos_orders/tx/${txId}`);
    if (!res.ok) {
      showToast("Receipt details not found or not a POS order.", "error");
      return;
    }
    const order = await res.json();

    const rcptFormatted = formatDocNo("RCPT", order.receipt_no || txId);
    const invFormatted = order.invoice_number ? ` (Inv: ${formatDocNo("INV", order.invoice_number)})` : "";
    document.getElementById("rd-tx-id").textContent = rcptFormatted + invFormatted;
    document.getElementById("rd-cashier").textContent =
      order.cashier_name || "System";
    document.getElementById("rd-date").textContent = formatDisplayDate(
      order.order_date,
      true,
    );

    const tbody = document.getElementById("rd-items-body");
    tbody.innerHTML = "";

    if (!order.items || order.items.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="4" style="text-align:center; color:var(--text-muted); padding:20px;">Itemized data not available for this legacy receipt.</td></tr>';
    } else {
      order.items.forEach((item) => {
        tbody.innerHTML += `
                    <tr>
                        <td style="padding:8px; border-bottom:1px solid var(--border);">${item.product_name}</td>
                        <td style="text-align:center; padding:8px; border-bottom:1px solid var(--border);">${item.qty}</td>
                        <td style="text-align:right; padding:8px; border-bottom:1px solid var(--border);">UGX ${item.price.toLocaleString()}</td>
                        <td style="text-align:right; padding:8px; border-bottom:1px solid var(--border); font-weight:bold;">UGX ${(item.total || item.price * item.qty).toLocaleString()}</td>
                    </tr>
                `;
      });
    }

    document.getElementById("rd-grand-total").textContent =
      `UGX ${order.total_amount.toLocaleString()}`;
    document.getElementById("receipt-details-modal").classList.remove("hidden");
  } catch (e) {
    console.error("Error fetching receipt details:", e);
    showToast("Network error fetching receipt details.", "error");
  }
}

async function populateCashierSelect() {
  try {
    const res = await fetchAuth(`${API_URL}/employees`);
    if (!res.ok) return;
    const data = await res.json();
    const select = document.getElementById("report-cashier-select");
    const currentVal = select.value;
    select.innerHTML = '<option value="">All Cashiers</option>';
    data.employees.forEach((emp) => {
      if (emp.role === "Cashier" || emp.role === "CEO" || emp.role === "HR") {
        const opt = document.createElement("option");
        opt.value = emp.id;
        opt.textContent = emp.nickname || `${emp.first_name} ${emp.last_name}`;
        select.appendChild(opt);
      }
    });
    const optTech = document.createElement("option");
    optTech.value = "9999";
    optTech.textContent = "System Technician";
    select.appendChild(optTech);
    select.value = currentVal;
  } catch (e) {
    console.error("Error populating cashiers:", e);
  }
}

async function loadCashierReport() {
  const start = document.getElementById("report-start-date").value;
  const end = document.getElementById("report-end-date").value;
  const cashierId = document.getElementById("report-cashier-select").value;
  const cashierLabel = document.getElementById("report-cashier-select").options[document.getElementById("report-cashier-select").selectedIndex]?.text || "All Cashiers";

  if (!start || !end) {
    showToast("Please select both start and end dates.", "error");
    return;
  }

  let url = `${API_URL}/reports/sme-cashier?start_date=${start}&end_date=${end}`;
  if (cashierId) url += `&cashier_id=${cashierId}`;

  try {
    const res = await fetchAuth(url);
    if (!res.ok) throw new Error("Failed to load report");
    const data = await res.json();

    // ── SUMMARY TABLE ──
    const tbody = document.querySelector("#cashier-report-table tbody");
    tbody.innerHTML = "";

    if (!data.reports || data.reports.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-muted);">No records found in this period.</td></tr>';
    } else {
      data.reports.forEach((rep) => {
        const tr = document.createElement("tr");
        const inc = parseFloat(rep.total_income) || 0;
        const exp = parseFloat(rep.total_expense) || 0;
        const net = inc - exp;
        const netColor = net >= 0 ? "var(--success)" : "var(--danger)";
        tr.innerHTML = `
                  <td style="font-weight:bold;">${rep.cashier_name || "System Technician"}</td>
                  <td style="text-align:center;">${rep.income_count || 0}</td>
                  <td style="text-align:center;">${rep.expense_count || 0}</td>
                  <td style="text-align:right; color:var(--success);">UGX ${inc.toLocaleString()}</td>
                  <td style="text-align:right; color:var(--danger);">UGX ${exp.toLocaleString()}</td>
                  <td style="text-align:right; font-weight:bold; color:${netColor};">UGX ${net.toLocaleString()}</td>
              `;
        tbody.appendChild(tr);
      });
    }

    // ── DETAIL TRANSACTIONS ──
    let detailContainer = document.getElementById("cashier-report-detail");
    if (!detailContainer) {
      detailContainer = document.createElement("div");
      detailContainer.id = "cashier-report-detail";
      document.getElementById("sme-view-reports").appendChild(detailContainer);
    }

    const txList = data.transactions || [];
    
    // Aggregate new summary fields from data.reports
    let aggCashSales = 0;
    let aggMomoSales = 0;
    let aggTotalSales = 0;
    let aggTotalIncome = 0;
    let aggTotalExpense = 0;
    if (data.reports) {
      data.reports.forEach(r => {
        aggCashSales += parseFloat(r.cash_sales) || 0;
        aggMomoSales += parseFloat(r.momo_sales) || 0;
        aggTotalSales += parseFloat(r.total_sales) || 0;
        aggTotalIncome += parseFloat(r.total_income) || 0;
        aggTotalExpense += parseFloat(r.total_expense) || 0;
      });
    }

    const grandNet = aggTotalIncome - aggTotalExpense;

    // Store for print function
    window._lastReportData = { 
      txList, start, end, cashierLabel,
      totalIncome: aggTotalIncome, 
      totalExpense: aggTotalExpense, 
      grandNet,
      cashSales: aggCashSales,
      momoSales: aggMomoSales,
      totalSales: aggTotalSales
    };

    let txRows = "";
    txList.forEach((tx) => {
      // FLOAT_IN and CASH_IN are cash going INTO the drawer — treat as income
      const isIncome = tx.type === "INCOME" || tx.type === "FLOAT_IN" || tx.type === "CASH_IN";
      const color = isIncome ? "#10b981" : "#ef4444";
      const sign = isIncome ? "+" : "-";
      const typeLabel = tx.type === "FLOAT_IN" ? "Opening Float" : tx.type === "CASH_IN" ? "Cash In" : tx.type;
      const rn = formatDocNo("RCPT", tx.receipt_no || tx.id);
      txRows += `
        <tr data-tx-id="${tx.id}" style="cursor:pointer;" onclick="if(typeof selectTxRow==='function')selectTxRow(this)">
          <td style="padding:6px 8px; border-bottom:1px solid var(--border); font-family:monospace; color:var(--primary);">${rn}</td>
          <td style="padding:6px 8px; border-bottom:1px solid var(--border); font-size:0.8rem;">${formatDisplayDate(tx.transaction_date, true)}</td>
          <td style="padding:6px 8px; border-bottom:1px solid var(--border); font-size:0.8rem;">${tx.cashier_name || "—"}</td>
          <td style="padding:6px 8px; border-bottom:1px solid var(--border);">${tx.description || "—"} <span style="font-size:0.75rem;color:var(--text-muted);">[${typeLabel}]</span></td>
          <td style="padding:6px 8px; border-bottom:1px solid var(--border); font-weight:bold; color:${color}; text-align:right;">${sign}UGX ${Number(tx.amount || 0).toLocaleString()}</td>
        </tr>`;
    });

    const netColor2 = grandNet >= 0 ? "#10b981" : "#ef4444";
    detailContainer.innerHTML = `
      <div style="margin-top:24px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <h3 style="margin:0; font-size:1rem; color:var(--text);">
          <i class="fa-solid fa-list"></i> Transactions — ${start} to ${end} &nbsp;|&nbsp; ${cashierLabel}
          <span style="font-size:0.8rem; color:var(--text-muted); margin-left:8px;">${txList.length} records</span>
        </h3>
        <button onclick="printCashierReport('${start}','${end}','${cashierLabel}')" class="primary-btn" style="padding:8px 18px; font-size:0.85rem;">
          <i class="fa-solid fa-print"></i> Print Report
        </button>
      </div>
      <div style="overflow-x:auto; margin-top:12px;">
        <table style="width:100%; border-collapse:collapse; font-size:0.85rem;">
          <thead>
            <tr style="background:var(--primary); color:white;">
              <th style="padding:8px; text-align:left;">RCPT #</th>
              <th style="padding:8px; text-align:left;">Date & Time</th>
              <th style="padding:8px; text-align:left;">Cashier</th>
              <th style="padding:8px; text-align:left;">Description</th>
              <th style="padding:8px; text-align:right;">Amount</th>
            </tr>
          </thead>
          <tbody>${txRows || '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);">No transactions in this period.</td></tr>'}</tbody>
          <tfoot>
            <tr style="background:var(--surface); font-weight:bold; border-top:2px solid var(--primary);">
              <td colspan="3" style="padding:8px;"></td>
              <td style="padding:8px; text-align:right;">TOTAL INCOME:</td>
              <td style="padding:8px; text-align:right; color:#10b981;">+UGX ${aggTotalIncome.toLocaleString()}</td>
            </tr>
            <tr style="background:var(--surface); font-weight:bold;">
              <td colspan="3"></td>
              <td style="padding:8px; text-align:right;">TOTAL EXPENSE:</td>
              <td style="padding:8px; text-align:right; color:#ef4444;">-UGX ${aggTotalExpense.toLocaleString()}</td>
            </tr>
            <tr style="background:var(--surface); font-weight:bold; font-size:1rem;">
              <td colspan="3"></td>
              <td style="padding:8px; text-align:right;">NET:</td>
              <td style="padding:8px; text-align:right; color:${netColor2};">UGX ${grandNet.toLocaleString()}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  } catch (e) {
    console.error("Error fetching report:", e);
    showToast("Error fetching report data.", "error");
  }
}

window.printCashierReport = function(start, end, cashierLabel) {
  const rpt = window._lastReportData || {};
  const txList = rpt.txList || [];
  const totalIncome = rpt.totalIncome || 0;
  const totalExpense = rpt.totalExpense || 0;
  const grandNet = rpt.grandNet || 0;

  const bizName = (document.getElementById("business-name-display")?.innerText ||
    localStorage.getItem("jomish_biz_name") || "Jomish Business Suite").toUpperCase();
  const bizLoc = localStorage.getItem("jomish_biz_location") || "";
  const bizTel = localStorage.getItem("jomish_biz_contact") || "";

  // First and last transaction times
  const firstTx = txList[0];
  const lastTx = txList[txList.length - 1];
  const fmtTime = (iso) => {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleTimeString("en-UG", { timeZone: "Africa/Kampala", hour: "2-digit", minute: "2-digit" }); }
    catch(e) { return iso; }
  };
  const startTime = fmtTime(firstTx?.transaction_date);
  const endTime = fmtTime(lastTx?.transaction_date);

  const cashSales = rpt.cashSales || 0;
  const momoSales = rpt.momoSales || 0;
  const totalSales = rpt.totalSales || 0;
  const expenses = rpt.totalExpense || 0;
  // Note: we use "Net Cash" instead of "End Cash" since there is no Start Cash for an arbitrary date range.
  const netCash = cashSales + totalIncome - expenses;

  const printHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Cashier Report</title>
  <style>
    @page { size: 80mm auto; margin: 3mm 2mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Courier New', monospace; font-size: 11px; width: 76mm; color: #000; background: #fff; }
    .center { text-align: center; }
    .biz { font-size: 14px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; }
    .sub { font-size: 10px; color: #444; margin-top: 1px; }
    .divider { border-top: 1px dashed #888; margin: 5px 0; }
    .divider-solid { border-top: 1px solid #000; margin: 5px 0; }
    /* Flex row: left 50%, right 50% left-aligned, matching standard receipts exactly */
    .row, .row-head, .total-row, .net-row {
      display: flex;
      margin: 2px 0;
      font-size: 10pt;
    }
    .row { border-bottom: 1px dashed #888; }
    .row-head { border-bottom: 1px dashed #888; font-weight: bold; }
    .total-row { margin-top: 4px; font-weight: bold; font-size: 11pt; }
    .net-row { border-top: 1px solid #000; margin-top: 4px; font-weight: bold; font-size: 12pt; padding-top: 2px; }
    
    .row span:first-child,
    .row-head span:first-child,
    .total-row span:first-child,
    .net-row span:first-child { width: 50%; }
    
    .row span:last-child,
    .row-head span:last-child,
    .total-row span:last-child,
    .net-row span:last-child { width: 50%; text-align: left; }
    
    .footer { text-align: center; font-size: 9pt; color: #555; margin-top: 10px; border-top: 1px dashed #888; padding-top: 6px; }
  </style>
</head>
<body>
  <div class="center">
    <div class="biz">${bizName}</div>
    ${bizLoc ? `<div class="sub">${bizLoc}</div>` : ""}
    ${bizTel ? `<div class="sub">${bizTel}</div>` : ""}
  </div>
  <div class="divider"></div>
  <div class="center" style="font-weight:bold;font-size:12px;">CASHIER REPORT</div>
  <div style="font-size:10px; margin:3px 0;">
    <div>Cashier: <strong>${cashierLabel}</strong></div>
    <div>Date: ${start} to ${end}</div>
    <div>Time: ${startTime} &ndash; ${endTime}</div>
    <div>Records: ${txList.length}</div>
  </div>
  <div class="row"><span>Cash Sales:</span><span>UGX ${cashSales.toLocaleString()}</span></div>
  <div class="row"><span>Mobile Money:</span><span>UGX ${momoSales.toLocaleString()}</span></div>
  <div class="row"><span>Total Sales:</span><span>UGX ${totalSales.toLocaleString()}</span></div>
  <div class="row"><span>Expenses Paid:</span><span>UGX ${expenses.toLocaleString()}</span></div>
  <div class="divider"></div>
  <div class="row bold" style="font-size:13pt;"><span>Net Cash:</span><span>UGX ${netCash.toLocaleString()}</span></div>
  <div class="footer">
    <div>Printed: ${new Date().toLocaleString("en-UG", {timeZone:"Africa/Kampala"})}</div>
    <div style="font-size:8px;font-style:italic;">Powered by Jomish Business Suite</div>
  </div>
</body>
</html>`;

  // Use iframe to avoid double-print and popup blockers
  let oldFrame = document.getElementById("print-iframe-report");
  if (oldFrame) oldFrame.remove();
  const iframe = document.createElement("iframe");
  iframe.id = "print-iframe-report";
  iframe.style.cssText = "position:absolute;width:0;height:0;border:none;left:-9999px;top:-9999px;";
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open(); doc.write(printHtml); doc.close();
  iframe.onload = () => {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => iframe.remove(), 2000);
  };
};

async function handleAddTx(e) {
  e.preventDefault();

  const amount = parseFloat(document.getElementById("tx-amount").value);
  const type = document.getElementById("tx-type").value;
  const description = document.getElementById("tx-desc").value;

  const payload = { amount, type, description };

  const backdateToggle = document.getElementById("tx-backdate-toggle");
  if (backdateToggle && backdateToggle.checked) {
    const datetimeVal = document.getElementById("tx-datetime").value;
    if (datetimeVal) {
      payload.transaction_date = new Date(datetimeVal).toISOString();
    }
  }

  try {
    const res = await fetchAuth(`${API_URL}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      showToast("Transaction saved", "success");
      document.getElementById("add-tx-modal").classList.add("hidden");
      document.getElementById("form-add-tx").reset();

      // Hide backdate container on reset
      const container = document.getElementById("tx-datetime-container");
      if (container) container.classList.add("hidden");

      loadTransactions();
      loadDashboard();
    } else {
      const data = await res.json();
      showToast(data.error || "Failed to save transaction", "danger");
    }
  } catch (e) {
    showToast("Network error. Please check server.", "danger");
  }
}

function toggleBackdateField() {
  const isChecked = document.getElementById("tx-backdate-toggle").checked;
  const container = document.getElementById("tx-datetime-container");
  if (container) {
    if (isChecked) {
      container.classList.remove("hidden");
      const now = new Date();
      const offsetMs = now.getTimezoneOffset() * 60 * 1000;
      const localISOTime = new Date(now.getTime() - offsetMs)
        .toISOString()
        .substring(0, 16);
      document.getElementById("tx-datetime").value = localISOTime;
    } else {
      container.classList.add("hidden");
      document.getElementById("tx-datetime").value = "";
    }
  }
}

window.selectTxRow = function(tr) {
  if (!tr) return;
  document.querySelectorAll("tr.tx-selected").forEach(r => {
    r.classList.remove("tx-selected");
    r.style.outline = "";
    r.style.outlineOffset = "";
    r.style.backgroundColor = "";
  });
  tr.classList.add("tx-selected");
  tr.style.outline = "2px solid var(--primary)";
  tr.style.outlineOffset = "-2px";
  tr.style.backgroundColor = "rgba(99, 102, 241, 0.12)";
  const txId = tr.getAttribute("data-tx-id") || tr.dataset.txId;
  if (txId) {
    window._selectedTxId = txId;
  }
};

// Global delegated click listener so ANY transaction row clicked in any table gets selected
document.addEventListener("click", function(e) {
  const row = e.target.closest("tr[data-tx-id]");
  if (row) {
    if (e.target.closest("button")) return;
    window.selectTxRow(row);
  }
});

async function deleteTransaction(id, silent = false) {
  const receiptNo = String(id).padStart(4, "0"); // Note: uses raw id for delete confirm; receipt_no shown in list
  if (!silent) {
    if (
      !confirm(
        `WARNING: Are you absolutely sure you want to permanently delete transaction RCPT-${receiptNo}? This action is irreversible and will affect the financial portal history.`,
      )
    ) {
      return;
    }
  }

  try {
    const res = await fetchAuth(`${API_URL}/transactions/${id}`, {
      method: "DELETE",
    });
    if (res.ok) {
      const resData = await res.json().catch(() => ({}));
      const deletedPosOrderIds = resData.pos_order_ids || (resData.pos_order_id ? [resData.pos_order_id] : []);
      if (!silent) {
        showToast(
          `Transaction RCPT-${receiptNo} deleted successfully.`,
          "success",
        );
      }
      // Instantly remove from Pending tab and Customer Invoices
      if (typeof removePendingOrderFromUI === "function") {
        for (const pId of deletedPosOrderIds) {
          removePendingOrderFromUI(pId, id);
        }
      }
      if (window.OfflineDB && typeof window.OfflineDB.bustCache === "function") {
        await Promise.allSettled([
          window.OfflineDB.bustCache("/deliveries"),
          window.OfflineDB.bustCache("/customer-invoices"),
          window.OfflineDB.bustCache("/transactions"),
          window.OfflineDB.bustCache("/pos_orders")
        ]);
      }
      // Instantly remove row from DOM
      const rows = document.querySelectorAll(`tr[data-tx-id="${id}"]`);
      rows.forEach(r => r.remove());

      // Reload UI
      if (typeof loadTransactions === "function") loadTransactions();
      if (typeof loadDashboard === "function") loadDashboard();
      if (typeof loadPendingCOD === "function") loadPendingCOD(true);
      if (typeof loadCustomerInvoices === "function") loadCustomerInvoices();
      if (typeof loadCashierReport === "function") {
        const reportView = document.getElementById("sme-view-reports");
        if (reportView && reportView.style.display !== "none") {
          loadCashierReport();
        }
      }
    } else {
      if (!silent) {
        const data = await res.json().catch(() => ({}));
        const errMsg = data.error || "Access Denied";
        showToast("Error deleting transaction: " + errMsg, "danger");
        alert("Error deleting transaction: " + errMsg);
      }
    }
  } catch (e) {
    console.error("Delete Transaction Error:", e);
    if (!silent) {
      showToast("Network error. Check server connection.", "danger");
      alert("Network error. Check server connection.");
    }
  }
}

// ── F8: Cashier can delete a selected transaction row silently ─────────────
window.addEventListener("keydown", async function(e) {
  const isF8 = e.key === "F8" || 
               e.key === "f8" || 
               e.code === "F8" || 
               e.keyCode === 119 || 
               e.which === 119;
  if (!isF8) return;

  const _role = (USER_ROLE || localStorage.getItem("jomish_role") || "").trim().toUpperCase();
  const isCashier = _role === "CASHIER" || _role === "KIOSK";
  if (!isCashier) return; // F8 is strictly for Cashier

  // Find selected transaction ID
  let txId = null;
  let targetRow = null;

  // 1. Check if receipt details modal is open
  const receiptModal = document.getElementById("receipt-details-modal");
  if (receiptModal && !receiptModal.classList.contains("hidden") && window._activeReceiptModalTxId) {
    txId = window._activeReceiptModalTxId;
    targetRow = document.querySelector(`tr[data-tx-id="${txId}"]`);
    receiptModal.classList.add("hidden");
  }

  // 2. Check if a row is selected
  if (!txId) {
    targetRow = document.querySelector("#transactions-table tr.tx-selected") ||
                document.querySelector("#cashier-report-detail tr.tx-selected") ||
                document.querySelector("tr.tx-selected") ||
                (window._selectedTxId ? document.querySelector(`tr[data-tx-id="${window._selectedTxId}"]`) : null);
    if (targetRow) {
      txId = targetRow.getAttribute("data-tx-id") || targetRow.dataset.txId;
    } else if (window._selectedTxId) {
      txId = window._selectedTxId;
    }
  }

  // Silent: does nothing when tapped without selecting
  if (!txId) return;

  e.preventDefault();
  e.stopPropagation();

  // Instantly remove row from DOM
  if (targetRow) targetRow.remove();
  const allTargetRows = document.querySelectorAll(`tr[data-tx-id="${txId}"]`);
  allTargetRows.forEach(r => r.remove());
  window._selectedTxId = null;

  await deleteTransaction(parseInt(txId, 10), true); // true = silent deletion (no toast, no confirm, no alert)
}, true);

async function resetDatabase() {
  // Custom prompt for Electron compatibility to avoid native confirm() focus loss
  const promptOverlay = document.createElement("div");
  promptOverlay.style =
    "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:9999; display:flex; justify-content:center; align-items:center;";
  promptOverlay.innerHTML = `
        <div style="background:var(--surface); padding:24px; border-radius:12px; border:1px solid #EF4444; width:450px; text-align:center;">
            <h3 style="color:#EF4444; margin-top:0;"><i class="fa-solid fa-bell"></i> CRITICAL WARNING</h3>
            <p style="font-size:0.9rem; color:var(--danger); font-weight:bold; margin-bottom:10px;">
                You are about to permanently delete the entire database. This will wipe all employees, transactions, product inventories, attendance logs, and internal messages. This action is IRREVERSIBLE.
            </p>
            <p style="font-size:0.9rem; color:var(--text-muted); margin-bottom:16px;">To proceed with database destruction, please enter the Technician password below:</p>
            <input type="text" id="reset-verify-input" onkeydown="event.stopPropagation()" style="width:100%; padding:10px; border-radius:6px; border:1px solid var(--border); background:var(--background); color:var(--text); text-align:center; margin-bottom:16px; user-select: text; -webkit-user-select: text; pointer-events: auto; -webkit-text-security: disc;" autofocus>
            <div style="display:flex; gap:10px;">
                <button id="reset-cancel-btn" class="secondary-btn" style="flex:1;">Cancel</button>
                <button id="reset-confirm-btn" class="primary-btn" style="flex:1; background:#EF4444; border:none;">Verify & Destroy</button>
            </div>
        </div>
    `;
  document.body.appendChild(promptOverlay);
  setTimeout(() => document.getElementById("reset-verify-input").focus(), 100);

  document.getElementById("reset-cancel-btn").onclick = () => {
    document.body.removeChild(promptOverlay);
    alert("Verification failed. Reset aborted.");
  };

  document.getElementById("reset-confirm-btn").onclick = async () => {
    const pass2 = document.getElementById("reset-verify-input").value;
    if (pass2 !== "JomishRecovery99!!" && pass2 !== "Jomish9!!") {
      document.body.removeChild(promptOverlay);
      alert(
        "Verification failed. Incorrect technician password. Reset aborted.",
      );
      return;
    }
    document.body.removeChild(promptOverlay);

    const btn = document.getElementById("btn-reset-db");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Destroying Database...";
    }

    try {
      const res = await fetchAuth(`${API_URL}/system/reset`, {
        method: "POST",
      });
      if (res.ok) {
        alert(
          "Database successfully wiped. Seed accounts created:\n- CEO: ceo / ceo123\n- HR: admin / admin123\n\nYou will now be redirected to log in with these new credentials.",
        );

        // Clear storage and redirect to login
        localStorage.clear();
        window.location.href = "login.html?reset=success";
      } else {
        const data = await res.json();
        alert("Reset Error: " + (data.error || "Operation failed."));
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Clear Database & Reset System";
        }
      }
    } catch (e) {
      console.error("Reset database error:", e);
      alert("Network/connection error. Database wipe failed.");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Clear Database & Reset System";
      }
    }
  };
}

async function handleBackup() {
  try {
    const res = await fetchAuth(`${API_URL}/system/backup`);
    if (!res.ok) {
      const data = await res.json();
      alert("Backup failed: " + (data.error || "Unauthorized"));
      return;
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const dateStr = new Date().toISOString().split("T")[0];
    a.download = `jomish_backup_${dateStr}.sqlite`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
  } catch (e) {
    alert("Backup error: " + e.message);
  }
}

async function handleRestore(input) {
  const file = input.files[0];
  if (!file) return;

  if (
    !confirm(
      `<i class="fa-solid fa-bell"></i> DANGER: You are about to completely OVERWRITE the current database with "${file.name}". All existing data will be permanently lost and replaced by this backup. Are you absolutely sure you want to proceed?`,
    )
  ) {
    input.value = "";
    return;
  }

  try {
    const res = await fetchAuth(`${API_URL}/system/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });

    if (res.ok) {
      alert(
        "Database restored successfully! The system will now restart to apply changes. Please wait a moment and then log back in.",
      );
      localStorage.clear();
      setTimeout(() => {
        window.location.href = "login.html";
      }, 2000);
    } else {
      const data = await res.json();
      alert("Restore Error: " + (data.error || "Failed to restore database."));
    }
  } catch (e) {
    alert("Network/connection error during restore.");
  }
  input.value = "";
}

// â”€â”€ Global Window Assignments for inline onclick handlers â”€â”€
window.toggleBackdateField = toggleBackdateField;
window.deleteTransaction = deleteTransaction;
window.resetDatabase = resetDatabase;
window.handleBackup = handleBackup;
window.handleRestore = handleRestore;
window.openEditProduct = openEditProduct;
window.previewEditPhoto = previewEditPhoto;
window.previewProductPhoto = previewProductPhoto;
window.openEmployeeNotes = openEmployeeNotes;

window.clockOutStaff = clockOutStaff;
window.handleScan = handleScan;
window.restockProduct = restockProduct;
window.deleteProduct = deleteProduct;
window.printProductLabels = printProductLabels;
window.switchHRView = switchHRView;
window.switchSecretaryView = switchSecretaryView;
window.navigateCalendar = navigateCalendar;
window.goToToday = goToToday;
window.deleteCalEvent = deleteCalEvent;
window.handleCalEventSubmit = handleCalEventSubmit;
window.openMinutesModal = openMinutesModal;
window.saveMeetingMinutes = saveMeetingMinutes;
window.toggleMeetMinutes = toggleMeetMinutes;
window.installSystemUpdate = installSystemUpdate;
window.loadCredits = loadCredits;
window.loadDevices = loadDevices;
window.loadMessages = loadMessages;
window.loadPayrollStatus = loadPayrollStatus;
window.loadPOSExpenses = loadPOSExpenses;
window.loadRoles = loadRoles;
window.printPayrollList = printPayrollList;
window.fetchNewEmails = fetchNewEmails;
window.openNewEmailCapsule = openNewEmailCapsule;
window.openBlastEmailCapsule = openBlastEmailCapsule;
window.closeEmailCapsule = closeEmailCapsule;
window.toggleCapsuleReply = toggleCapsuleReply;
window.bridgeStaffEmail = bridgeStaffEmail;
window.quickEmail = quickEmail;
window.searchStaffDirectory = searchStaffDirectory;
window.openPassModal = openPassModal;
window.generateAutoPassword = generateAutoPassword;
window.addNewRoleBlueprint = addNewRoleBlueprint;
window.deleteRoleBlueprint = deleteRoleBlueprint;
window.saveBusinessConfig = saveBusinessConfig;
window.toggleSick = toggleSick;
window.toggleTheme = toggleTheme;
window.handleLogout = handleLogout;
window.numpadPress = numpadPress;
window.numpadExact = numpadExact;
window.confirmPayment = confirmPayment;
window.getInvoice = getInvoice;
window.closePaymentPanel = closePaymentPanel;
window.doPrint = doPrint;
window.closeReceipt = closeReceipt;
window.doPrintID = doPrintID;
window.closeIDCard = closeIDCard;
window.doPrintLabels = doPrintLabels;
window.closeLabels = closeLabels;
// window.printTimetable is defined later on as an async function on the window object
window.testPrintReceipt = testPrintReceipt;
window.testPrintLabel = testPrintLabel;
window.testPrintID = testPrintID;
window.generateIDCard = generateIDCard;
window.handleLogoUpload = handleLogoUpload;
window.triggerPhotoUpload = triggerPhotoUpload;
window.loadSystemUsers = loadSystemUsers;
window.openCreditPaymentModal = openCreditPaymentModal;
window.submitCreditPayment = submitCreditPayment;
window.printStatement = printStatement;
window.toggleAutoStart = toggleAutoStart;
window.kickDevice = kickDevice;
window.dismissDataLoss = dismissDataLoss;
window.updateRole = updateRole;
window.promptAddRole = promptAddRole;
window.submitConfirmPassword = submitConfirmPassword;
window.quickUploadPhoto = quickUploadPhoto;
window.updateCartQty = updateCartQty;
window.setCartQty = setCartQty;

// ============================================================
// PETTY CASH HUB
// ============================================================
let _currentPettyCashShiftId = null;

async function loadPettyCash() {
  const token = localStorage.getItem("jomish_token");
  try {
    const shiftRes = await fetchAuth(`${API_URL}/shifts/status`);
    if (!shiftRes || !shiftRes.id) {
      document.getElementById("petty-cash-body").innerHTML =
        `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No active shift. Petty cash disabled.</td></tr>`;
      return;
    }
    _currentPettyCashShiftId = shiftRes.id;

    const res = await fetch(
      `${API_URL}/petty-cash?shift_id=${_currentPettyCashShiftId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(await res.text());
    const entries = await res.json();

    let total = 0;
    const tbody = document.getElementById("petty-cash-body");
    if (!entries.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No petty cash entries yet for this shift.</td></tr>`;
    } else {
      tbody.innerHTML = entries
        .map((e) => {
          total += parseFloat(e.amount);
          const date = new Date(
            e.created_at.replace(" ", "T"),
          ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          return `<tr>
                    <td>${e.purpose}</td>
                    <td style="text-align:right;">UGX ${parseFloat(e.amount).toLocaleString()}</td>
                    <td>${e.recorded_by}</td>
                    <td>${date}</td>
                    <td class="admin-only hidden" style="text-align:center;">
                        <button onclick="deletePettyCash(${e.id})" class="sm-btn danger"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>`;
        })
        .join("");
    }

    document.getElementById("petty-cash-total").textContent =
      `Total: UGX ${total.toLocaleString()}`;

    // Show/hide admin-only actions (like delete)
    document.querySelectorAll(".admin-only").forEach((el) => {
      if (USER_ROLE === "CEO" || USER_ROLE === "HR")
        el.classList.remove("hidden");
    });
  } catch (e) {
    console.error("[PettyCash] loadPettyCash error:", e);
  }
}

async function handlePettyCashSubmit(e) {
  e.preventDefault();
  if (!_currentPettyCashShiftId)
    return alert("No active shift. Cannot log petty cash.");
  const purpose = document.getElementById("pc-purpose").value.trim();
  const amount = document.getElementById("pc-amount").value;
  const token = localStorage.getItem("jomish_token");
  const body = {
    shift_id: _currentPettyCashShiftId,
    purpose,
    amount,
    recorded_by: window.USER_NAME || "Unknown",
  };

  const res = await fetch(`${API_URL}/petty-cash`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    document.getElementById("form-petty-cash").reset();
    await loadPettyCash();
  } else {
    const err = await res.json();
    alert("Error: " + err.error);
  }
}

async function deletePettyCash(id) {
  if (!confirm("Delete this petty cash entry?")) return;
  const token = localStorage.getItem("jomish_token");
  await fetch(`${API_URL}/petty-cash/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  await loadPettyCash();
}

window.deletePettyCash = deletePettyCash;

// Wire up petty cash form
document.addEventListener("DOMContentLoaded", () => {
  document
    .getElementById("form-petty-cash")
    ?.addEventListener("submit", handlePettyCashSubmit);
  // Bind it to the schedules navigation button to reload when they click the tab
  document
    .querySelectorAll('.nav-btn[data-target="schedules"]')
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        if (["Supervisor", "HR", "CEO"].includes(window.USER_ROLE)) {
          loadPettyCash();
        }
      });
    });
});

// ============================================================
// TRANSPORT / DELIVERY HUB
// ============================================================
let _deliveries = [];

async function loadDeliveries() {
  const token = localStorage.getItem("jomish_token");
  try {
    const res = await fetch(`${API_URL}/deliveries`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(await res.text());
    _deliveries = await res.json();
    renderDeliveries(_deliveries);
    updateDeliveryStats(_deliveries);
  } catch (e) {
    console.error("[Transport] loadDeliveries error:", e);
  }
}

function updateDeliveryStats(rows) {
  const count = (status) => rows.filter((r) => r.status === status).length;
  const el = (id, val) => {
    const e = document.getElementById(id);
    if (e) e.textContent = val;
  };
  el("trx-stat-pending", count("Pending"));
  el("trx-stat-transit", count("In Transit"));
  el("trx-stat-delivered", count("Delivered"));
  el("trx-stat-failed", count("Failed"));
}

const STATUS_COLORS = {
  Pending: "#F59E0B",
  "In Transit": "#3B82F6",
  Delivered: "#10B981",
  Failed: "#EF4444",
};

function renderDeliveries(rows) {
  const tbody = document.getElementById("deliveries-table-body");
  if (!tbody) return;
  const filter = (
    document.getElementById("trx-filter-status")?.value || ""
  ).toLowerCase();
  const search = (
    document.getElementById("trx-search")?.value || ""
  ).toLowerCase();
  const filtered = rows.filter((r) => {
    const matchStatus = !filter || r.status?.toLowerCase() === filter;
    const matchSearch =
      !search ||
      r.client_name?.toLowerCase().includes(search) ||
      r.client_phone?.toLowerCase().includes(search);
    return matchStatus && matchSearch;
  });
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:40px;"><i class="fa-solid fa-truck" style="font-size:2rem;display:block;margin-bottom:12px;opacity:0.3;"></i>No deliveries found.</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered
    .map((r) => {
      const color = STATUS_COLORS[r.status] || "#888";
      const date = formatDisplayDate(r.created_at, false);
      const canClaim =
        USER_ROLE === "Driver" && r.status === "Pending" && !r.driver_id;
      const myJobBadge =
        USER_ROLE === "Driver" && r.driver_name === USER_NAME
          ? `<span style="background:var(--success);color:white;padding:2px 6px;border-radius:4px;font-size:0.7rem;margin-left:5px;">My Job &#10003;</span>`
          : "";
      const claimBtn = canClaim
        ? `<button onclick="claimDelivery(${r.id})" class="sm-btn success" style="margin-right:5px;">Take Job</button>`
        : "";
      const mapBtn = `<button onclick="openDeliveryMap('${(r.client_location || "").replace(/'/g, "\\'")}')" class="sm-btn primary" style="margin-right:5px;" title="View Route on Map"><i class="fa-solid fa-map-location-dot"></i> Map</button>`;
      return `<tr>
            <td style="font-weight:bold;">Receipt #${r.receipt_number || r.order_id || r.id}</td>
            <td>${r.client_name || "—"} ${myJobBadge}</td>
            <td>${r.client_phone || "—"}</td>
            <td>${r.client_location || "—"}</td>
            <td><span style="background:${color}22;color:${color};padding:3px 10px;border-radius:20px;font-size:0.78rem;font-weight:700;">${r.status}</span></td>
            <td>${date}</td>
            <td style="display:flex;gap:6px;flex-wrap:wrap;">
                ${mapBtn}
                ${claimBtn}
                <select onchange="updateDeliveryStatus(${r.id}, this.value)" style="padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:0.78rem;">
                    ${["Pending", "In Transit", "Delivered", "Failed"].map((s) => `<option${r.status === s ? " selected" : ""}>${s}</option>`).join("")}
                </select>
                <button onclick="deleteDelivery(${r.id})" class="sm-btn danger" title="Delete"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>`;
    })
    .join("");
}

async function updateDeliveryStatus(id, status) {
  const token = localStorage.getItem("jomish_token");
  await fetch(`${API_URL}/deliveries/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ status }),
  });
  await loadDeliveries();
}

async function deleteDelivery(id) {
  if (!confirm("Delete this delivery record?")) return;
  const token = localStorage.getItem("jomish_token");
  await fetch(`${API_URL}/deliveries/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  await loadDeliveries();
}

async function claimDelivery(id) {
  const token = localStorage.getItem("jomish_token");
  try {
    const res = await fetch(`${API_URL}/deliveries/${id}/claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      showToast("Job claimed successfully!", "success");
      await loadDeliveries();
    } else {
      const err = await res.json();
      showToast(err.error || "Failed to claim job", "danger");
    }
  } catch (e) {
    showToast("Network error while claiming job", "danger");
  }
}

function openDeliveryMap(clientLocation) {
  if (!clientLocation || clientLocation === "—") {
    showToast("No client location provided for this delivery.", "warning");
    return;
  }
  const origin = encodeURIComponent("Kampala, Uganda"); // Adjust business location as needed
  const destination = encodeURIComponent(clientLocation);
  const url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}`;
  window.open(url, "_blank");
}

async function handleNewDeliverySubmit(e) {
  e.preventDefault();
  const token = localStorage.getItem("jomish_token");
  const body = {
    client_name: document.getElementById("del-client-name").value.trim(),
    client_phone: document.getElementById("del-client-phone").value.trim(),
    client_location: document
      .getElementById("del-client-location")
      .value.trim(),
    driver: document.getElementById("del-driver").value.trim(),
    items: document.getElementById("del-items").value.trim(),
    fee: document.getElementById("del-fee").value || 0,
    status: document.getElementById("del-status").value,
    notes: document.getElementById("del-notes").value.trim(),
  };
  const res = await fetch(`${API_URL}/deliveries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    document.getElementById("form-new-delivery").reset();
    document.getElementById("delivery-modal").classList.add("hidden");
    await loadDeliveries();
  } else {
    const err = await res.json();
    alert("Error: " + err.error);
  }
}

window.updateDeliveryStatus = updateDeliveryStatus;
window.deleteDelivery = deleteDelivery;
window.claimDelivery = claimDelivery;
window.loadDeliveries = loadDeliveries;
window.openDeliveryMap = openDeliveryMap;

// Wire Transport tab load
document
  .querySelectorAll('.nav-btn[data-target="transport-hub"]')
  .forEach((btn) => {
    btn.addEventListener("click", () => loadDeliveries());
  });

// Wire delivery modal buttons
document.getElementById("btn-new-delivery")?.addEventListener("click", () => {
  const m = document.getElementById("delivery-modal");
  if (m) {
    m.classList.remove("hidden");
    m.style.display = "flex";
  }
});
document
  .getElementById("btn-close-delivery-modal")
  ?.addEventListener("click", () => {
    const m = document.getElementById("delivery-modal");
    if (m) {
      m.classList.add("hidden");
      m.style.cssText = "";
    }
  });
document
  .getElementById("form-new-delivery")
  ?.addEventListener("submit", handleNewDeliverySubmit);

// Wire filter/search
document
  .getElementById("trx-filter-status")
  ?.addEventListener("change", () => renderDeliveries(_deliveries));
document
  .getElementById("trx-search")
  ?.addEventListener("input", () => renderDeliveries(_deliveries));
document
  .getElementById("btn-refresh-deliveries")
  ?.addEventListener("click", () => loadDeliveries());

// ---- Fix receipt buttons (contextIsolation blocks inline onclick) ----
document
  .getElementById("btn-close-receipt")
  ?.addEventListener("click", closeReceipt);
document.getElementById("btn-do-print")?.addEventListener("click", doPrint);

// ==== EMPLOYEE NOTES LOGIC ====
async function openEmployeeNotes(id, name) {
  document.getElementById("note-emp-id").value = id;
  document.getElementById("note-emp-name").innerText =
    `Performance Notes: ${name}`;
  document.getElementById("emp-notes-modal").classList.remove("hidden");
  loadEmployeeNotes(id);
}

async function loadEmployeeNotes(id) {
  try {
    const res = await fetchAuth(`${API_URL}/notes/${id}`);
    const data = await res.json();
    const list = document.getElementById("notes-list");
    list.innerHTML = "";

    if (!data.notes || data.notes.length === 0) {
      list.innerHTML =
        '<p style="text-align:center; color:#94A3B8; padding:20px;">No performance notes found for this employee.</p>';
      return;
    }

    data.notes.forEach((n) => {
      const div = document.createElement("div");
      div.style =
        "background: rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:8px; padding:15px; margin-bottom:10px;";
      const badgeColor =
        n.note_type === "POSITIVE"
          ? "#10B981"
          : n.note_type === "WARNING"
            ? "#EF4444"
            : "#6366F1";

      div.innerHTML = `
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <span style="font-size:0.7rem; color:${badgeColor}; font-weight:bold; text-transform:uppercase;">${n.note_type}</span>
                    <span style="font-size:0.7rem; color:#94A3B8;">${formatDisplayDate(n.created_at, true)}</span>
                </div>
                <p style="font-size:0.9rem; margin-bottom:8px;">${n.note_text}</p>
                <div style="font-size:0.7rem; color:#94A3B8; text-align:right;">By: ${n.author_name || "System"}</div>
            `;
      list.appendChild(div);
    });
  } catch (e) {
    console.error("Notes Error:", e);
  }
}

async function handleAddNote(e) {
  e.preventDefault();
  const id = document.getElementById("note-emp-id").value;
  const text = document.getElementById("note-text").value;
  const type = document.getElementById("note-type").value;

  try {
    const res = await fetchAuth(`${API_URL}/notes`, {
      method: "POST",
      body: JSON.stringify({
        employee_id: id,
        note_text: text,
        note_type: type,
      }),
    });
    if (res.ok) {
      document.getElementById("note-text").value = "";
      loadEmployeeNotes(id);
    }
  } catch (e) {
    console.error("Save Note Error:", e);
  }
}

async function handleScan() {
  const identifier = document.getElementById("scan-emp-id").value;
  if (!identifier) {
    document.getElementById("qr-reader-results").innerHTML =
      '<i class="fa-solid fa-triangle-exclamation"></i> Please type an ID or use the Camera.';
    return;
  }
  const res = await fetchAuth(`${API_URL}/attendance/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, scan_type: "MANUAL" }),
  });
  const data = await res.json();
  if (res.ok) {
    document.getElementById("qr-reader-results").innerHTML =
      (data.already_in
        ? '<i class="fa-solid fa-circle-info"></i> '
        : "<i class='fa-solid fa-check'></i> ") + data.message;
    document.getElementById("scan-emp-id").value = "";
    loadAttendance();
  } else {
    alert(data.error || "ID not found");
  }
}

async function clockOutStaff(id) {
  if (!confirm("Log Clock OUT for this staff member?")) return;
  try {
    const res = await fetchAuth(`${API_URL}/attendance/manual-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employee_id: id }),
    });
    if (res.ok) {
      loadAttendance();
    } else {
      const data = await res.json();
      alert(data.error);
    }
  } catch (e) {
    console.error(e);
  }
}

async function loadSoldBarcodes() {
  try {
    const res = await fetchAuth(`${API_URL}/barcodes/sold`);
    const data = await res.json();
    if (data.sold_barcodes) {
      soldBarcodes = new Set(data.sold_barcodes);
    }
  } catch (e) {
    console.error("Load sold barcodes error:", e);
  }
}

window.currentInventoryTab = "all";

window.setInventoryFilterTab = function(tabName) {
  window.currentInventoryTab = tabName || "all";
  document.querySelectorAll(".inv-filter-btn").forEach((btn) => btn.classList.remove("active"));
  const activeBtn = document.getElementById("inv-tab-" + window.currentInventoryTab);
  if (activeBtn) activeBtn.classList.add("active");

  // Keep topbar Low Stock nav item in sync
  const lowNav = document.getElementById("pos-nav-lowstock");
  const stockNav = document.getElementById("pos-nav-stock");
  if (window.currentInventoryTab === "low") {
    if (lowNav) lowNav.classList.add("active");
    if (stockNav) stockNav.classList.remove("active");
  } else if (window.currentInventoryTab === "all") {
    if (lowNav) lowNav.classList.remove("active");
    if (stockNav) stockNav.classList.add("active");
  }

  const searchVal = document.getElementById("inventory-search")?.value || "";
  window.filterInventory(searchVal);
};

window.filterInventory = function(query) {
  const inputEl = document.getElementById("inventory-search");
  const q = (query !== undefined ? query : (inputEl ? inputEl.value : "")).trim().toLowerCase();
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  const cards = document.querySelectorAll("#inventory-grid .product-card");

  let visibleCount = 0;
  let totalSoldFiltered = 0;
  let soldTodayFiltered = 0;

  cards.forEach((card) => {
    const name = (card.dataset.name || card.querySelector("h4")?.textContent || "").toLowerCase();
    const category = (card.dataset.category || card.querySelector(".badge")?.textContent || "").toLowerCase();
    const barcode = (card.dataset.barcode || "").toLowerCase();
    const cardText = (card.textContent || "").toLowerCase();

    // Check multi-term text search
    const textMatches = terms.length === 0 || terms.every((t) =>
      name.includes(t) || category.includes(t) || barcode.includes(t) || cardText.includes(t)
    );

    // Check sub-tab filter (All vs Low Stock vs Out of Stock)
    const isInfinite = card.dataset.trackStock === "0";
    const stock = parseFloat(card.dataset.stock) || 0;
    const thresh = parseFloat(card.dataset.lowStockThreshold) || 10;
    let tabMatches = true;
    if (window.currentInventoryTab === "low") {
      tabMatches = !isInfinite && stock < thresh;
    } else if (window.currentInventoryTab === "out") {
      tabMatches = !isInfinite && stock <= 0;
    }

    const matches = textMatches && tabMatches;

    if (matches) {
      card.classList.remove("is-hidden");
      card.style.removeProperty("display");
      visibleCount++;
      const soldVal = Number(card.dataset.totalSold) || 0;
      const todayVal = Number(card.dataset.soldToday) || 0;
      totalSoldFiltered += soldVal;
      soldTodayFiltered += todayVal;
    } else {
      card.classList.add("is-hidden");
      card.style.setProperty("display", "none", "important");
    }
  });

  const totalSoldBarEl = document.getElementById("stock-total-items-sold");
  const todaySoldBarEl = document.getElementById("stock-today-items-sold");
  const totalCountBarEl = document.getElementById("stock-total-products-count");
  if (totalSoldBarEl) totalSoldBarEl.textContent = totalSoldFiltered.toLocaleString();
  if (todaySoldBarEl) todaySoldBarEl.textContent = soldTodayFiltered.toLocaleString();
  if (totalCountBarEl) totalCountBarEl.textContent = visibleCount.toLocaleString();

  // Handle empty state message
  let emptyEl = document.getElementById("inventory-empty-state");
  if (visibleCount === 0) {
    if (!emptyEl) {
      emptyEl = document.createElement("div");
      emptyEl.id = "inventory-empty-state";
      emptyEl.style = "grid-column: 1 / -1; text-align: center; padding: 40px 20px; color: var(--text-muted); font-size: 0.95rem;";
      document.getElementById("inventory-grid")?.appendChild(emptyEl);
    }
    const filterDesc = window.currentInventoryTab === "low" ? "low stock items" : (window.currentInventoryTab === "out" ? "out of stock items" : "products");
    emptyEl.innerHTML = '<i class="fa-solid fa-box-open" style="font-size:2rem; margin-bottom:10px; display:block; opacity:0.5;"></i> No ' + filterDesc + ' found' + (terms.length > 0 ? ' matching "' + q + '"' : '') + '.';
    emptyEl.style.display = "block";
  } else if (emptyEl) {
    emptyEl.style.display = "none";
  }
};

async function loadInventory() {
  try {
    if (window.OfflineDB && typeof window.OfflineDB.bustCache === "function") {
      await window.OfflineDB.bustCache("/api/products").catch(() => {});
    }
    const res = await fetchAuth(`${API_URL}/products?force_refresh=true&_t=${Date.now()}`);
    const data = await res.json();
    const grid = document.getElementById("inventory-grid");
    if (!grid) return;
    grid.innerHTML = "";

    const prods = data.products || [];

    // Calculate overall products sold counters
    let totalAllSold = 0;
    let totalAllSoldToday = 0;
    prods.forEach((p) => {
      totalAllSold += Number(p.total_sold) || 0;
      totalAllSoldToday += Number(p.sold_today) || 0;
    });

    const totalSoldBarEl = document.getElementById("stock-total-items-sold");
    const todaySoldBarEl = document.getElementById("stock-today-items-sold");
    const totalCountBarEl = document.getElementById("stock-total-products-count");
    if (totalSoldBarEl) totalSoldBarEl.textContent = totalAllSold.toLocaleString();
    if (todaySoldBarEl) todaySoldBarEl.textContent = totalAllSoldToday.toLocaleString();
    if (totalCountBarEl) totalCountBarEl.textContent = prods.length.toLocaleString();

    // Update Dashboard Low Stock Count (exclude infinite-stock / made-to-order products)
    const lowStock = prods.filter((p) => p.track_stock !== 0 && p.stock < (p.low_stock_threshold || 10));
    const outStock = prods.filter((p) => p.track_stock !== 0 && p.stock <= 0);
    const lowStockCountEl = document.getElementById("stat-low-stock-count");
    if (lowStockCountEl) {
      lowStockCountEl.textContent = `${lowStock.length} items running low`;
      lowStockCountEl.parentElement.parentElement.style.background =
        lowStock.length > 0 ? "#FEF3C7" : "var(--surface)";
    }

    // Update sub-tabs counts and topbar badge
    const invCountAll = document.getElementById("inv-count-all");
    if (invCountAll) invCountAll.textContent = prods.length;
    const invCountLow = document.getElementById("inv-count-low");
    if (invCountLow) invCountLow.textContent = lowStock.length;
    const invCountOut = document.getElementById("inv-count-out");
    if (invCountOut) invCountOut.textContent = outStock.length;

    const navLowBadge = document.getElementById("pos-lowstock-badge");
    if (navLowBadge) {
      navLowBadge.textContent = lowStock.length;
      navLowBadge.style.display = lowStock.length > 0 ? "inline-flex" : "none";
    }

    prods.forEach((p) => {
      const isInfinite = p.track_stock === 0;
      const thresh = p.low_stock_threshold || 10;
      const card = document.createElement("div");
      card.className = `product-card management-card ${!isInfinite && p.stock < thresh ? "low-stock" : ""}`;
      card.dataset.totalSold = Number(p.total_sold) || 0;
      card.dataset.soldToday = Number(p.sold_today) || 0;
      card.dataset.stock = Number(p.stock) || 0;
      card.dataset.lowStockThreshold = thresh;
      card.dataset.trackStock = p.track_stock === undefined ? 1 : p.track_stock;
      card.dataset.name = (p.name || '').toLowerCase();
      card.dataset.category = (p.category || '').toLowerCase();
      card.dataset.barcode = ((p.barcode || '') + ' ' + (p.barcode_end || '')).toLowerCase();

      const catClass = `category-${(p.category || "General").toLowerCase()}`;
      const imageHtml =
        p.photo_base64 && p.photo_base64.length > 50
          ? `<div class="product-img-container"><img src="${p.photo_base64}" alt="${p.name}"></div>`
          : (p.has_photo ? `<div class="product-img-container"><img data-photo-id="${p.id}" class="lazy-prod-photo" alt="${p.name}" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3C/svg%3E"></div>` : `<div class="product-img-container placeholder ${catClass}">${getCategoryIcon(p.category)}</div>`);

      const showAdminProfit = ["CEO", "HR"].includes(USER_ROLE);
      let profitHtml = "";
      if (showAdminProfit) {
        const bp = p.buying_price || 0;
        const selling = p.price || 0;
        const profit = selling - bp;
        profitHtml = `
                    <div style="margin-top:8px; font-size:0.72rem; color:#A78BFA; display:flex; justify-content:space-between; background:rgba(167,139,250,0.08); padding:4px 8px; border-radius:6px; border:1px solid rgba(167,139,250,0.2); width: 100%;">
                        <span><i class="fa-solid fa-briefcase"></i> CEO Cost: <strong>UGX ${bp.toLocaleString()}</strong></span>
                        <span><i class="fa-solid fa-chart-line"></i> Margin: <strong>UGX ${profit.toLocaleString()}</strong></span>
                    </div>
                `;
      }

      const totalSold = Number(p.total_sold) || 0;
      const soldToday = Number(p.sold_today) || 0;
      const soldCounterHtml = `
                    <div style="margin-top:6px; font-size:0.75rem; color:#10B981; display:flex; justify-content:space-between; align-items:center; background:rgba(16,185,129,0.08); padding:5px 8px; border-radius:6px; border:1px solid rgba(16,185,129,0.22); width: 100%;">
                        <span><i class="fa-solid fa-fire" style="color:#F59E0B;"></i> Sold: <strong style="color:#10B981; font-size:0.82rem;">${totalSold.toLocaleString()}</strong> <small style="color:var(--text-muted);">sold</small></span>
                        <span style="font-size:0.7rem; color:var(--text-muted);"><i class="fa-solid fa-calendar-day" style="color:#10B981;"></i> Today: <strong style="color:var(--text);">${soldToday.toLocaleString()}</strong></span>
                    </div>
                `;

      card.innerHTML = `
                ${imageHtml}
                <div class="product-info management-info">
                    <div style="display:flex; justify-content:space-between; align-items:start;">
                        <div>
                            <h4>${p.name}</h4>
                            <span class="badge" style="font-size:0.6rem; background:rgba(255,255,255,0.1);">${p.category}</span>
                        </div>
                        <div class="price" style="font-size:0.85rem;">UGX ${p.price.toLocaleString()}</div>
                    </div>
                    <div style="margin-top:8px; font-size:0.7rem; color:#94A3B8; display:flex; align-items:center; gap:6px;">
                        <span><i class="fa-solid fa-tag"></i></span>
                        <span>Barcodes: ${p.barcode || "—"}${p.barcode_end && p.barcode_end !== p.barcode ? " → " + p.barcode_end : ""}</span>
                    </div>
                    ${profitHtml}
                    ${soldCounterHtml}
                    <div style="margin-top:6px; display:flex; justify-content:space-between; align-items:center;">
                        <div class="stock" style="font-weight:bold; color:${p.track_stock === 0 ? "var(--text-muted)" : (p.stock < thresh ? "var(--danger)" : "var(--primary)")};">
                            ${p.track_stock === 0 ? '<span style="color:#8B5CF6; font-weight:700;"><i class="fa-solid fa-infinity"></i> Unlimited</span>' : "Stock: " + p.stock + (p.stock < thresh ? ` <small style="color:var(--danger);font-size:0.7rem;">(Alert &lt; ${thresh})</small>` : "")}
                        </div>
                        <div style="display:flex; gap:4px; align-items:center;">
                            <input type="number" id="restock-qty-${p.id}" value="10" min="1" style="width:55px; background:#fff; border:1px solid #ccc; border-radius:6px; color:#111 !important; font-size:0.8rem; padding:4px 4px; text-align:center; font-weight:700;">
                            <button class="sm-btn primary" onclick="const val = parseInt(document.getElementById('restock-qty-${p.id}').value); if(val > 0) restockProduct(${p.id}, val);" title="Add Stock & Print Labels">+</button>
                            <button class='sm-btn' onclick='openStockMovements(${p.id}, ${JSON.stringify(p.name).replace(/"/g, "&quot;")}, ${p.stock}, ${thresh})' title="Stock Movement History" style="background:rgba(99,102,241,0.15); color:#6366f1; border:1px solid rgba(99,102,241,0.3);"><i class="fa-solid fa-chart-line"></i></button>
                            <button class='sm-btn warning' onclick='printProductLabels(${JSON.stringify(p).replace(/'/g, "&apos;")})' title="Reprint All Labels"><i class="fa-solid fa-tag"></i></button>
                            <button class='sm-btn success' onclick="openEditProduct(${p.id}, ${JSON.stringify(p.name).replace(/"/g, "&quot;")}, ${JSON.stringify(p.category || 'General').replace(/"/g, "&quot;")}, ${p.price}, ${JSON.stringify(p.barcode || '').replace(/"/g, "&quot;")}, ${JSON.stringify(p.barcode_end || '').replace(/"/g, "&quot;")}, ${p.buying_price || 0}, ${p.track_stock === undefined ? 1 : p.track_stock}, ${thresh})" title="Edit"><i class="fa-solid fa-pencil"></i></button>
                            <button class='sm-btn danger' onclick="deleteProduct(${p.id})" title="Delete"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>
                </div>`;
      grid.appendChild(card);
    });

    lazyLoadProductImages();
  } catch (e) {
    console.error(e);
  }
}

function triggerPhotoUpload(productId) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async () => {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    if (file.size > 5 * 1024 * 1024) {
      alert("Image too large! Max 5MB.");
      return;
    }
    const base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsDataURL(file);
    });
    try {
      const res = await fetchAuth(`${API_URL}/products/${productId}/photo`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo_base64: base64 }),
      });
      if (res.ok) {
        alert("Product photo updated!");
        loadInventory();
        loadPOSProducts();
      } else {
        const data = await res.json();
        alert("Error: " + (data.error || "Failed to update photo"));
      }
    } catch (e) {
      console.error(e);
      alert("Network error updating photo.");
    }
  };
  input.click();
}

async function submitBulkStock(id, amount) {
  try {
    const res = await fetchAuth(`${API_URL}/products/${id}/stock`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ increment: amount }),
    });
    if (res.ok) {
      const data = await res.json();
      cachedProducts = []; // Clear cache so scanner picks up new ranges
      loadInventory();
      loadPOSProducts();
      loadDashboard();
      if (data.new_labels) {
        const { count } = data.new_labels;
        showToast(`+${count} units restocked.`, "success");
      } else {
        showToast("Stock updated", "success");
      }
    } else {
      alert("Failed to update stock. Is the server running?");
    }
  } catch (e) {
    console.error(e);
    alert("Connection error. Check your network.");
  }
}

async function restockProduct(id, amount) {
  if (amount <= 0) return;
  const p = cachedProducts.find((x) => x.id == id);
  const productName = p ? p.name : "Unknown Product";
  openScanSession(id, productName, amount);
}

let _currentScanProductId = null;
let _currentScanProductName = null;
let _scanCount = 0;
let _scanTargetCount = 0;

async function handleAddProduct(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  const originalText = btn.textContent;

  const photoInput = document.getElementById("add-prod-photo");
  let photoBase64 = null;

  if (photoInput.files && photoInput.files[0]) {
    const file = photoInput.files[0];
    if (file.size > 5 * 1024 * 1024) {
      alert("Image too large! Please select an image under 5MB.");
      return;
    }
    photoBase64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (ev) => resolve(ev.target.result);
      reader.readAsDataURL(file);
    });
  }

  btn.textContent = "Saving...";
  btn.disabled = true;

  const payload = {
    name: document.getElementById("add-prod-name").value,
    category: document.getElementById("add-prod-cat").value,
    price: parseFloat(document.getElementById("add-prod-price").value),
    buying_price:
      parseFloat(document.getElementById("add-prod-buying-price").value) || 0,
    photo_base64: photoBase64,
    track_stock: document.getElementById("add-prod-track-stock").checked ? 1 : 0,
    low_stock_threshold: parseInt(document.getElementById("add-prod-low-stock-threshold")?.value) || 10,
  };

  try {
    const res = await fetchAuth(`${API_URL}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = await res.json();
      cachedProducts = []; // Clear cache

      // Close add modal, reset form
      const targetQty =
        parseInt(document.getElementById("add-prod-qty").value) || 1;

      document.getElementById("add-product-modal").classList.add("hidden");
      document.getElementById("form-add-product").reset();
      document.getElementById("prod-photo-preview").style.display = "none";

      // Open Scan Session Modal
      openScanSession(data.id, payload.name, targetQty);
    } else {
      const data = await res.json();
      alert(
        "Error saving product: " + (data.error || "Check server connection"),
      );
    }
  } catch (err) {
    console.error(err);
    alert("Network error. Is the server running?");
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

window.openScanSession = function (productId, productName, targetQuantity = 1) {
  _currentScanProductId = productId;
  _currentScanProductName = productName;
  _scanCount = 0;
  _scanTargetCount = targetQuantity;

  document.getElementById("scan-prod-name").textContent = productName;
  document.getElementById("scan-count").textContent = "0";
  const st = document.getElementById("scan-target");
  if (st) st.textContent = targetQuantity.toString();
  document.getElementById("scan-last-status").textContent = "Ready to scan...";
  document.getElementById("scan-input").value = "";

  const m = document.getElementById("scan-session-modal");
  m.classList.remove("hidden");
  m.style.display = "flex";

  setTimeout(() => {
    document.getElementById("scan-input").focus();
  }, 100);
};

window.closeScanSession = function () {
  _currentScanProductId = null;
  const m = document.getElementById("scan-session-modal");
  m.classList.add("hidden");
  m.style.cssText = "";

  // Refresh inventory to show newly registered items
  window._skipProductReload = true;
  loadInventory();
  loadPOSProducts();
  setTimeout(() => {
    window._skipProductReload = false;
  }, 2000);
};

window.submitScanInput = async function () {
  if (!_currentScanProductId) return;
  const inputEl = document.getElementById("scan-input");
  const barcode = inputEl.value.trim();
  if (!barcode) return;

  inputEl.value = ""; // clear for next scan
  inputEl.focus();

  const statusEl = document.getElementById("scan-last-status");
  statusEl.textContent = `Registering ${barcode}...`;
  statusEl.style.color = "var(--text)";

  const remaining = _scanTargetCount - _scanCount;
  const qty = remaining > 0 ? remaining : 1;

  try {
    const res = await fetchAuth(
      `${API_URL}/products/${_currentScanProductId}/scan-assign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barcode, amount: qty }),
      },
    );

    const data = await res.json();
    if (res.ok) {
      // Since we fulfill the entire remaining quantity in one scan, add `qty` to `_scanCount`
      _scanCount += qty;
      document.getElementById("scan-count").textContent = _scanCount;
      statusEl.textContent = `[OK] ${barcode} linked successfully! (+${qty} stock)`;
      statusEl.style.color = "var(--success)";

      if (_scanCount >= _scanTargetCount) {
        statusEl.textContent = `Target reached! Completing...`;
        setTimeout(() => window.closeScanSession(), 800);
      }
    } else {
      statusEl.textContent = `[ERROR] ${data.error}`;
      statusEl.style.color = "var(--danger)";
    }
  } catch (err) {
    statusEl.textContent = `[ERROR] Network error`;
    statusEl.style.color = "var(--danger)";
  }
};

window.generateBulkBarcodes = async function () {
  if (!_currentScanProductId) return;
  const remaining = _scanTargetCount - _scanCount;
  if (remaining <= 0) {
    window.closeScanSession();
    return;
  }
  const btn = document.getElementById("btn-generate-bulk");
  const originalText = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
  btn.disabled = true;

  const statusEl = document.getElementById("scan-last-status");
  statusEl.textContent = `Generating ${remaining} Jomish Labels...`;

  try {
    const res = await fetchAuth(
      `${API_URL}/products/${_currentScanProductId}/generate-labels-bulk`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: remaining }),
      },
    );
    if (res.ok) {
      const data = await res.json();
      _scanCount += remaining;
      document.getElementById("scan-count").textContent = _scanCount;
      statusEl.textContent = `[OK] ${remaining} labels generated!`;
      statusEl.style.color = "var(--success)";
      showToast(`${remaining} labels generated!`, "success");
      setTimeout(() => window.closeScanSession(), 1000);
    } else {
      const data = await res.json();
      alert("Failed to generate bulk labels: " + data.error);
    }
  } catch (e) {
    alert("Network error");
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
};

window.ignoreRemainingBarcodes = async function () {
  if (!_currentScanProductId) return;
  const remaining = _scanTargetCount - _scanCount;
  if (remaining <= 0) {
    window.closeScanSession();
    return;
  }
  const btn = document.getElementById("btn-ignore-barcodes");
  const originalText = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Updating...';
  btn.disabled = true;

  try {
    await submitBulkStock(_currentScanProductId, remaining);
    _scanCount += remaining;
    document.getElementById("scan-count").textContent = _scanCount;
    document.getElementById("scan-last-status").textContent =
      `[OK] Stock added.`;
    setTimeout(() => window.closeScanSession(), 500);
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
};

async function deleteProduct(id) {
  if (!confirm("Delete this product?")) return;
  const res = await fetchAuth(`${API_URL}/products/${id}`, {
    method: "DELETE",
  });
  if (res.ok) {
    alert("Product Deleted.");
    loadInventory();
    loadPOSProducts();
  } else {
    alert("Failed to delete product.");
  }
}

// ==== EDIT PRODUCT ====
function openEditProduct(
  id,
  name,
  category,
  price,
  barcode,
  barcodeEnd,
  buyingPrice = 0,
  trackStock = 1,
  lowStockThreshold = 10,
) {
  document.getElementById("edit-prod-id").value = id;
  document.getElementById("edit-prod-name").value = name;
  document.getElementById("edit-prod-cat").value = category;
  document.getElementById("edit-prod-price").value = price;
  document.getElementById("edit-prod-barcode").value = barcode || "";
  document.getElementById("edit-prod-barcode-end").value = barcodeEnd || "";
  document.getElementById("edit-prod-photo").value = "";
  document.getElementById("edit-prod-preview").style.display = "none";
  const bpInput = document.getElementById("edit-prod-buying-price");
  if (bpInput) bpInput.value = buyingPrice;
  const tsCheckbox = document.getElementById("edit-prod-track-stock");
  if (tsCheckbox) tsCheckbox.checked = (trackStock !== 0);
  const lstInput = document.getElementById("edit-prod-low-stock-threshold");
  if (lstInput) lstInput.value = lowStockThreshold || 10;
  document.getElementById("edit-product-modal").classList.remove("hidden");
}

function previewEditPhoto(input) {
  const preview = document.getElementById("edit-prod-preview");
  const img = preview.querySelector("img");
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = (e) => {
      img.src = e.target.result;
      preview.style.display = "block";
    };
    reader.readAsDataURL(input.files[0]);
  } else {
    preview.style.display = "none";
  }
}

async function handleEditProduct(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  const originalText = btn.textContent;
  btn.textContent = "Saving...";
  btn.disabled = true;

  const id = document.getElementById("edit-prod-id").value;
  const photoInput = document.getElementById("edit-prod-photo");
  let photo_base64 = null;

  if (photoInput.files && photoInput.files[0]) {
    const file = photoInput.files[0];
    if (file.size > 5 * 1024 * 1024) {
      alert("Image too large! Max 5MB.");
      btn.textContent = originalText;
      btn.disabled = false;
      return;
    }
    photo_base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (ev) => resolve(ev.target.result);
      reader.readAsDataURL(file);
    });
  }

  // 1. Local Collision Check (Pre-flight)
  const currentId = parseInt(document.getElementById("edit-prod-id").value);
  const newBarcode = document
    .getElementById("edit-prod-barcode")
    .value.trim()
    .toLowerCase();

  const duplicate = cachedProducts.find((p) => {
    if (p.id === currentId) return false; // Skip self
    const existingBarcode = (p.barcode || "").toString().trim().toLowerCase();
    return newBarcode !== "" && existingBarcode === newBarcode;
  });

  if (duplicate) {
    alert(
      `Duplicate Barcode: This barcode is already assigned to '${duplicate.name}'.`,
    );
    btn.textContent = originalText;
    btn.disabled = false;
    return;
  }

  const payload = {
    name: document.getElementById("edit-prod-name").value,
    category: document.getElementById("edit-prod-cat").value,
    price: parseFloat(document.getElementById("edit-prod-price").value),
    buying_price:
      parseFloat(document.getElementById("edit-prod-buying-price").value) || 0,
    barcode: document.getElementById("edit-prod-barcode").value,
    barcode_end: document.getElementById("edit-prod-barcode-end").value || null,
    photo_base64,
    track_stock: document.getElementById("edit-prod-track-stock").checked ? 1 : 0,
    low_stock_threshold: parseInt(document.getElementById("edit-prod-low-stock-threshold")?.value) || 10,
  };

  try {
    const res = await fetchAuth(`${API_URL}/products/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      document.getElementById("edit-product-modal").classList.add("hidden");
      document.getElementById("form-edit-product").reset();
      document.getElementById("edit-prod-preview").style.display = "none";
      loadInventory();
      loadPOSProducts();
    } else {
      const data = await res.json();
      alert("Error: " + (data.error || "Update failed"));
    }
  } catch (err) {
    console.error(err);
    alert("Network error. Is the server running?");
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// ==== SHIFT & ACCESS MANAGEMENT ====
function previewProductPhoto(input) {
  const preview = document.getElementById("prod-photo-preview");
  const previewImg = preview.querySelector("img");
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = (e) => {
      previewImg.src = e.target.result;
      preview.style.display = "block";
    };
    reader.readAsDataURL(input.files[0]);
  } else {
    preview.style.display = "none";
  }
}

async function triggerWipe() {
  resetDatabase();
}

// ===== SYSTEM UPDATE HANDLER =====
async function installSystemUpdate() {
  const fileInput = document.getElementById("sys-update-file");
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    alert("Please select a .zip update package first.");
    return;
  }

  const file = fileInput.files[0];
  if (!file.name.toLowerCase().endsWith(".zip")) {
    alert("Invalid file format. Please upload a .zip update package.");
    return;
  }

  const confirmUpdate = confirm(
    `<i class="fa-solid fa-triangle-exclamation"></i> SYSTEM UPDATE INITIALIZATION\n\nYou are about to apply a system feature update. Ensure nobody is actively doing critical work on POS or HR as the server will momentarily restart.\n\nProceed with update?`,
  );
  if (!confirmUpdate) return;

  const btn = document.getElementById("btn-install-update");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Uploading & Extracting...';

  try {
    const res = await fetchAuth(`${API_URL}/system/update`, {
      method: "POST",
      body: file,
      headers: {
        "Content-Type": "application/zip",
      },
    });

    const data = await res.json();
    if (res.ok) {
      alert(
        "UPDATE STAGED SUCCESSFULLY!\n\nThe update script has been generated and the system will now shut down to apply the new files. It will automatically restart in about 5 seconds.\n\nPlease DO NOT close any terminal windows that pop up.",
      );
      // Wait a few seconds for the batch script to kill the server and do its job
      setTimeout(() => {
        btn.innerHTML = '<span class="spinner"></span>Applying Files (Wait...)';
      }, 2000);

      // Reload the frontend after 8 seconds (assuming batch script is done)
      setTimeout(() => {
        window.location.reload(true);
      }, 8000);
    } else {
      alert("Update Failed: " + (data.error || "Unknown error"));
      btn.disabled = false;
      btn.innerHTML = "Install Update & Restart";
    }
  } catch (e) {
    console.error("System Update Error:", e);
    alert("Network error. Check server connection.");
    btn.disabled = false;
    btn.innerHTML = "Install Update & Restart";
  }
}

let cachedEmployees = [];

async function loadUserAccounts() {
  try {
    const res = await fetchAuth(`${API_URL}/employees`);
    const data = await res.json();
    cachedEmployees = data.employees;
    const tbody = document.querySelector("#user-accounts-table tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    data.employees.forEach((emp) => {
      const tr = document.createElement("tr");
      let actionBtnText = "Set Access";
      if (emp.role === "Cashier") actionBtnText = "Use access";

      tr.innerHTML = `
                <td>${emp.first_name} ${emp.last_name}</td>
                <td>${emp.role}</td>
                <td>${emp.email}</td>
                <td style="font-weight:600; color:${emp.nickname ? "var(--primary)" : "var(--text-muted)"}">${emp.nickname || "—"}</td>
                <td>${emp.has_password ? `<i class="fa-solid fa-check"></i> Set` : `<i class="fa-solid fa-xmark"></i> Not Set`}</td>
                <td><button class="sm-btn primary" onclick="openPassModal(${JSON.stringify(emp).replace(/"/g, "&quot;")})">${actionBtnText}</button></td>
            `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error(e);
  }
}

async function loadSystemUsers(searchTerm = "") {
  try {
    const res = await fetchAuth(`${API_URL}/employees`);
    const data = await res.json();
    cachedEmployees = data.employees;
    const tbody = document.getElementById("sysusers-tbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    let filtered = data.employees;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (emp) =>
          (emp.first_name + " " + emp.last_name).toLowerCase().includes(term) ||
          (emp.nickname || "").toLowerCase().includes(term) ||
          (emp.username || "").toLowerCase().includes(term),
      );
    }

    if (filtered.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-muted);">No system users found.</td></tr>';
      return;
    }

    filtered.forEach((emp) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
                <td>${emp.first_name} ${emp.last_name}</td>
                <td><span style="background:var(--surface-hover); padding:2px 8px; border-radius:12px; font-size:0.8rem;">${emp.role}</span></td>
                <td style="font-family:monospace; color:var(--primary); font-weight:bold;">${emp.username || "—"}</td>
                <td style="font-weight:600; color:${emp.nickname ? "var(--success)" : "var(--text-muted)"}">${emp.nickname || "—"}</td>
                <td>${emp.has_password ? `<i class="fa-solid fa-check"></i> Set` : `<i class="fa-solid fa-xmark"></i> Not Set`}</td>
                <td><button class='sm-btn primary' onclick="openPassModal(${JSON.stringify(emp).replace(/"/g, "&quot;")})"><i class="fa-solid fa-key"></i> Edit Login</button></td>
            `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error(e);
  }
}

async function openPassModal(emp) {
  if (!emp) return; // Add mode is gone — creation happens in Add Employee

  const nameDisplay = document.getElementById("pass-name-display");
  const nameFields = document.getElementById("pass-name-fields");
  const nameLabel = document.getElementById("pass-emp-name-label");
  const modalTitle = document.getElementById("pass-modal-title");
  const pwdHint = document.getElementById("pass-pwd-hint");
  const submitBtn = document.getElementById("btn-pass-submit");

  // Reset form
  document.getElementById("form-set-password").reset();

  // Load all roles dynamically, pre-selecting the current one
  await loadRolesIntoSelect("pass-emp-role", emp.role || "");

  // Fill in employee details
  document.getElementById("pass-emp-id").value = emp.id;
  // Always use employee_code as the login ID if available
  const loginIdInput = document.getElementById("pass-emp-user");
  loginIdInput.value = emp.employee_code || emp.username || "";
  loginIdInput.readOnly = true; // Lock it so it cannot be changed
  loginIdInput.style.backgroundColor = "var(--surface-hover)"; // Visual cue for readonly

  document.getElementById("pass-emp-nickname").value = emp.nickname || "";
  document.getElementById("pass-new-pwd").value = "";

  // Danger Zone toggles
  const btnSuspend = document.getElementById("btn-suspend-account");
  const btnRestore = document.getElementById("btn-restore-account");
  if (emp.is_suspended) {
    btnSuspend.style.display = "none";
    btnRestore.style.display = "inline-flex";
    nameLabel.innerHTML = `${emp.first_name} ${emp.last_name} <span style="font-size:0.7rem; background:var(--danger); color:white; padding:2px 6px; border-radius:4px; vertical-align:middle; margin-left:8px;">SUSPENDED</span>`;
  } else {
    btnSuspend.style.display = "inline-flex";
    btnRestore.style.display = "none";
    nameLabel.textContent = `${emp.first_name} ${emp.last_name}`;
  }

  // Always EDIT mode — hide the "select worker" fields
  if (nameFields) nameFields.style.display = "none";
  nameDisplay.style.display = "block";
  modalTitle.innerHTML = '<i class="fa-solid fa-key"></i> Edit System Access';
  pwdHint.style.display = "block";
  submitBtn.textContent = "Save Changes";

  document.getElementById("set-password-modal").classList.remove("hidden");
}

function generateAutoPassword() {
  const pin = String(Math.floor(1000 + Math.random() * 9000)); // Always 4-digit numeric PIN
  document.getElementById("pass-new-pwd").value = pin;
}

async function handleUpdateAccess(e) {
  e.preventDefault();
  const empId = document.getElementById("pass-emp-id").value;
  const role = document.getElementById("pass-emp-role").value;
  const username = document.getElementById("pass-emp-user").value.trim();
  const nickname = document.getElementById("pass-emp-nickname").value.trim();
  const password = document.getElementById("pass-new-pwd").value;

  if (empId) {
    // â”€â”€ EDIT MODE: update credentials on existing employee â”€â”€
    const payload = { password, role, username, nickname };
    const res = await fetchAuth(`${API_URL}/users/${empId}/credentials`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      showToast(`User credentials updated!`, "success");
      document.getElementById("set-password-modal").classList.add("hidden");
      if (typeof loadEmployees === "function") loadEmployees();
      if (typeof loadUserAccounts === "function") loadUserAccounts();
      if (typeof loadSystemUsers === "function") loadSystemUsers();
    } else {
      const data = await res.json();
      alert(
        "Error: " +
          (data.error ||
            "Server rejected the update. Please RESTART the server."),
      );
    }
  } else {
    // â”€â”€ ADD MODE: create a brand new system user â”€â”€
    if (!empId) return alert("Please select a worker first.");
    if (!username) return alert("Please enter a login username.");
    if (!password) return alert("Please set an initial password.");

    const payload = { password, role, username, nickname };
    const res = await fetchAuth(`${API_URL}/users/${empId}/credentials`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      showToast(`System user "${firstName} ${lastName}" created!`, "success");
      document.getElementById("set-password-modal").classList.add("hidden");
      loadUserAccounts();
      loadSystemUsers();
      loadEmployees();
    } else {
      const data = await res.json();
      alert(
        "Error: " + (data.error || "Could not create user. Check the server."),
      );
    }
  }
}

function autoRedirect() {
  const _r = (USER_ROLE || "").toUpperCase();
  if (_r === "CASHIER" || _r === "FINANCE MANAGER" || _r === "WAITER" || _r === "SUPERVISOR") {
    const posBtn = document.querySelector('[data-target="pos-terminal"]');
    if (posBtn && posBtn.style.display !== "none") {
      posBtn.click();
    } else {
      const fallback = document.querySelector(
        '.sidebar nav .nav-btn:not([style*="display: none"])',
      );
      if (fallback) fallback.click();
    }
  } else if (USER_ROLE === "Security") {
    const attBtn = document.querySelector('[data-target="attendance"]');
    if (attBtn && attBtn.style.display !== "none") {
      attBtn.click();
    } else {
      const fallback = document.querySelector(
        '.sidebar nav .nav-btn:not([style*="display: none"])',
      );
      if (fallback) fallback.click();
    }
  } else if (USER_ROLE === "Receptionist") {
    const secBtn = document.querySelector('[data-target="secretary-hub"]');
    if (secBtn && secBtn.style.display !== "none") {
      secBtn.click();
    } else {
      const attBtn = document.querySelector('[data-target="attendance"]');
      if (attBtn && attBtn.style.display !== "none") {
        attBtn.click();
      } else {
        const fallback = document.querySelector(
          '.sidebar nav .nav-btn:not([style*="display: none"])',
        );
        if (fallback) fallback.click();
      }
    }
  }
}

async function handleLogout() {
  try {
    await fetch(`${API_URL}/logout`, { method: "POST" });
  } catch (e) {}
  // Clear all IndexedDB API cache to prevent stale data from one business
  // bleeding into a different user's session after login switch.
  try {
    if (window.OfflineDB && typeof window.OfflineDB.clearAllCache === "function") {
      await window.OfflineDB.clearAllCache();
    }
  } catch (e) {}
  // Clear ALL per-user localStorage keys — nothing must bleed into the next login
  const keysToRemove = [
    "jomish_token", "jomish_role", "jomish_name", "jomish_permissions",
    "jomish_user_id", "jomish_prefix", "jomish_active_shift"
  ];
  keysToRemove.forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
  window._hasActiveCashierShift = false;
  window._activeCashierShiftData = null;
  location.replace("login.html");
}

async function validateSession() {
  const token = localStorage.getItem("jomish_token");
  if (!token) return;
  try {
    const res = await fetch(`${API_URL}/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      // Only logout on explicit auth rejection (401/403), not on network failure
      if (res.status === 401 || res.status === 403) {
        try {
          await fetch(`${API_URL}/logout`, { method: "POST" });
        } catch (e) {}
        try {
          if (window.OfflineDB && typeof window.OfflineDB.clearAllCache === "function") {
            await window.OfflineDB.clearAllCache();
          }
        } catch (e) {}
        localStorage.removeItem("jomish_token");
        localStorage.removeItem("jomish_role");
        localStorage.removeItem("jomish_permissions");
        window.location.href = "login.html";
      }
    }
  } catch (e) {
    // Network error — likely offline, keep session valid
    console.warn("Session validation skipped (offline/network error).");
  }
}

async function loadSystemStatus() {
  try {
    const res = await fetch(`${API_URL}/system/status`);
    const data = await res.json();
    const dbStatus = document.getElementById("db-type-status");
    if (dbStatus) {
      dbStatus.innerText = data.dbType.toUpperCase() + " Engine";
      dbStatus.style.color = data.dbType === "postgres" ? "#10B981" : "#4F46E5";
    }

    // Update camera troubleshoot URL dynamically
    const troubleshootUrl = document.getElementById("troubleshoot-url");
    if (troubleshootUrl) {
      troubleshootUrl.innerText = window.location.origin;
    }

    const staffCount = document.getElementById("total-staff-status");
    if (staffCount) {
      const empRes = await fetch(`${API_URL}/employees`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("jomish_token")}`,
        },
      });
      const empData = await empRes.json();
      staffCount.innerText = (empData.employees?.length || 0) + " Members";
    }
  } catch (e) {
    console.error("System status fetch failed", e);
  }
}

async function handleAutoSchedule() {
  // Legacy prompt-based auto-schedule replaced by Smart Scheduler.
  // Delegate to the new IIFE function which reads the Business Blueprint.
  if (typeof window.smartAutoSchedule === "function") {
    window.smartAutoSchedule();
  } else {
    showToast("Navigate to the Shift Timetable tab to auto-schedule.", "info");
  }
}

window.printTimetable = async function () {
  const weekLabel = document.getElementById("tt-week-label")?.innerText || "";
  const companyName =
    document.getElementById("brand-name")?.innerText || "Jomish Business Suite";
  const today = new Date().toLocaleDateString("en-UG", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Parse from/to from the week label ("2024-01-01  →  2024-01-07")
  const parts = weekLabel.split("→").map((s) => s.trim());
  const from = parts[0];
  const to = parts[1];
  if (!from || !to) {
    alert("Timetable not loaded yet. Please wait.");
    return;
  }

  // Fetch live assignments
  let assignments = [];
  try {
    const res = await fetchAuth(
      `${API_URL}/shift-assignments?from=${from}&to=${to}`,
    );
    const data = await res.json();
    assignments = data.assignments || [];
  } catch (e) {
    alert("Could not load timetable data.");
    return;
  }

  // Build 7-day columns Mon→Sun
  const startDate = new Date(from + "T00:00:00");
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    return d;
  });
  const dayNames = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
  const dateLabels = days.map((d) =>
    d.toLocaleDateString("en-UG", { day: "2-digit", month: "short" }),
  );

  // Build per-employee map: id → {name, role, days: {dateStr → {slot, time}}}
  const empMap = {};
  assignments.forEach((a) => {
    const key = a.employee_id;
    if (!empMap[key])
      empMap[key] = {
        name: `${a.first_name} ${a.last_name}`,
        role: a.role,
        dayData: {},
      };
    empMap[key].dayData[a.shift_date] = {
      slot: a.slot || "",
      start: a.start_time || "",
      end: a.end_time || "",
    };
  });

  let employees = Object.values(empMap).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  // Ensure at least 15 rows (blank rows like the template)
  while (employees.length < 15)
    employees.push({ name: "", role: "", dayData: {} });

  // Build table rows
  const rowsHtml = employees
    .map((emp, idx) => {
      const bg = idx % 2 === 0 ? "#ffffff" : "#d9edf7";
      // Compute total hours for the week
      let totalHours = 0;
      days.forEach((d) => {
        const ds = d.toISOString().split("T")[0];
        const info = emp.dayData[ds];
        if (info && info.start && info.end) {
          const [sh, sm] = info.start.split(":").map(Number);
          const [eh, em] = info.end.split(":").map(Number);
          totalHours += Math.max(0, eh * 60 + em - (sh * 60 + sm)) / 60;
        }
      });
      const hoursStr = totalHours > 0 ? totalHours.toFixed(1) + " hrs" : "";

      const dayCells = days
        .map((d) => {
          const ds = d.toISOString().split("T")[0];
          const info = emp.dayData[ds];
          const cellText = info
            ? `${info.slot}${info.start ? "<br><small>" + info.start + "-" + info.end + "</small>" : ""}`
            : "";
          return `<td style="border:1px solid #2196a8; padding:5px 6px; text-align:center; font-size:8pt; vertical-align:middle; background:${bg}; -webkit-print-color-adjust:exact; print-color-adjust:exact;">${cellText}</td>`;
        })
        .join("");

      return `<tr>
            <td style="border:1px solid #2196a8; padding:5px 8px; font-weight:${emp.name ? "600" : "normal"}; font-size:9pt; background:${bg}; -webkit-print-color-adjust:exact; print-color-adjust:exact; white-space:nowrap;">${emp.name}</td>
            <td style="border:1px solid #2196a8; padding:5px 6px; text-align:center; font-size:8pt; background:${bg}; -webkit-print-color-adjust:exact; print-color-adjust:exact;">${hoursStr}</td>
            ${dayCells}
        </tr>`;
    })
    .join("");

  // Column header: DATE | HOURS | MON(date) | TUE(date) ...
  const dayHeaderCells = dayNames
    .map(
      (dn, i) =>
        `<th style="background:#1a9ab5; color:#fff; padding:7px 4px; border:1px solid #0e7a91; font-size:9pt; text-align:center; -webkit-print-color-adjust:exact; print-color-adjust:exact;">${dn}<br><span style="font-size:7pt; font-weight:normal;">${dateLabels[i]}</span></th>`,
    )
    .join("");

  const printWindow = window.open("", "_blank", "width=1100,height=750");
  if (!printWindow) {
    alert("Please allow popups to print the timetable.");
    return;
  }

  printWindow.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Weekly Shift Timetable — ${weekLabel}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: Arial, Helvetica, sans-serif; background: #fff; color: #000; padding: 12mm 10mm; }
        .top-title { font-size: 16pt; font-weight: bold; margin-bottom: 10px; }
        .meta-row { display: flex; justify-content: space-between; margin-bottom: 14px; gap: 20px; }
        .meta-box { display: flex; flex-direction: column; gap: 2px; }
        .meta-label { font-size: 7pt; text-transform: uppercase; letter-spacing: 0.5px; color: #555; }
        .meta-value { border: 1px solid #aaa; min-width: 180px; padding: 4px 8px; font-size: 10pt; min-height: 22px; }
        table { width: 100%; border-collapse: collapse; }
        .notes-section { margin-top: 20px; }
        .notes-title { text-align: center; font-size: 12pt; font-weight: bold; margin-bottom: 8px; letter-spacing: 2px; }
        .notes-row { border: 1px solid #2196a8; height: 22px; margin-bottom: -1px; }
        @media print {
            body { padding: 8mm 6mm; }
            @page { size: A3 landscape; margin: 8mm; }
        }
    </style>
</head>
<body>
    <div class="top-title">${companyName} — Weekly Staff Shift Timetable</div>
    <div class="meta-row">
        <div class="meta-box">
            <div class="meta-label">Week Beginning:</div>
            <div class="meta-value">${from}</div>
        </div>
        <div class="meta-box">
            <div class="meta-label">Week Ending:</div>
            <div class="meta-value">${to}</div>
        </div>
        <div style="flex:1;"></div>
        <div class="meta-box">
            <div class="meta-label">Printed By:</div>
            <div class="meta-value">${document.getElementById("user-display-name")?.innerText || ""}</div>
        </div>
        <div class="meta-box">
            <div class="meta-label">Date Printed:</div>
            <div class="meta-value" style="font-size:8pt;">${today}</div>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th style="background:#1a9ab5; color:#fff; padding:7px 8px; border:1px solid #0e7a91; font-size:9pt; text-align:left; -webkit-print-color-adjust:exact; print-color-adjust:exact; min-width:130px;">NAME / EMPLOYEE</th>
                <th style="background:#1a9ab5; color:#fff; padding:7px 6px; border:1px solid #0e7a91; font-size:9pt; text-align:center; -webkit-print-color-adjust:exact; print-color-adjust:exact; min-width:55px;">HOURS</th>
                ${dayHeaderCells}
            </tr>
        </thead>
        <tbody>
            ${rowsHtml}
        </tbody>
    </table>

    <div class="notes-section">
        <div class="notes-title">NOTES</div>
        ${Array.from({ length: 4 })
          .map(() => `<div class="notes-row"></div>`)
          .join("")}
    </div>

    <div style="margin-top:14px; display:flex; justify-content:space-between; font-size:7pt; color:#666; border-top:1px solid #ccc; padding-top:6px;">
        <span>Generated by Jomish Business Suite</span>
        <span>Confidential — Internal Use Only</span>
        <span>Page 1</span>
    </div>

    <script>
        window.onload = function() { window.print(); setTimeout(function() { window.close(); }, 1800); };
    <\/script>
</body>
</html>`);
  printWindow.document.close();
};

async function loadSchedules() {
  // Legacy function — the new IIFE module renders the timetable grid.
  // Only keep counter sync here for the summary bar.
  if (typeof window.loadShiftTimetable === "function") {
    const section = document.getElementById("schedules");
    if (section && section.classList.contains("active")) {
      window.loadShiftTimetable();
    }
  }
}

// ==== PRINT PRODUCT LABELS (by range) ====
async function printProductLabelsRange(productName, startNum, endNum, price) {
  if (isNaN(startNum) || isNaN(endNum)) {
    console.error("Cannot print: invalid barcode range", startNum, endNum);
    return;
  }

  const count = endNum - startNum + 1;
  if (count > 200 && !confirm(`This will generate ${count} labels. Continue?`))
    return;

  const container = document.getElementById("labels-container");
  if (!container) return;
  container.innerHTML = "";

  for (let i = 0; i < count; i++) {
    const currentCode = (startNum + i).toString();

    const labelDiv = document.createElement("div");
    labelDiv.className = "label-sticker";

    const nameEl = document.createElement("div");
    nameEl.style =
      "font-size: 5pt; font-family: helvetica, sans-serif; font-weight: bold; text-align: center; line-height: 1.1; width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;";
    nameEl.textContent = productName.toUpperCase();

    const priceEl = document.createElement("div");
    priceEl.style =
      "font-size: 4.5pt; font-family: helvetica, sans-serif; text-align: center; margin-bottom: 2px;";
    if (price) {
      priceEl.textContent = "UGX " + Number(price).toLocaleString();
    } else {
      priceEl.textContent = " ";
    }

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style = "width: 100%; height: 12mm; max-width: 35mm;";
    try {
      JsBarcode(svg, currentCode, {
        format: "CODE128",
        width: 1.5,
        height: 50,
        displayValue: false,
        margin: 10,
      });
    } catch (e) {
      JsBarcode(svg, currentCode, {
        format: "codabar",
        width: 1.5,
        height: 50,
        displayValue: false,
        margin: 10,
      });
    }

    const codeEl = document.createElement("div");
    codeEl.style =
      "font-size: 6pt; font-family: 'Courier New', monospace; font-weight: bold; text-align: center; margin-top: 1px;";
    codeEl.textContent = currentCode;

    const footerEl = document.createElement("div");
    footerEl.style =
      "font-size: 2.5pt; font-family: helvetica, sans-serif; text-align: center; color: #666; margin-top: auto;";
    footerEl.textContent = "JOMISH";

    labelDiv.appendChild(nameEl);
    labelDiv.appendChild(priceEl);
    labelDiv.appendChild(svg);
    labelDiv.appendChild(codeEl);
    labelDiv.appendChild(footerEl);

    container.appendChild(labelDiv);
  }

  document
    .getElementById("label-overlay")
    .classList.add("receipt-modal-visible");
  showToast(`${count} barcode labels ready for printing!`, "success");
}

function doPrintLabels() {
  if (isPrinting) return;
  isPrinting = true;

  clearAllPrintModes();
  document.body.classList.add("print-mode-label");

  // Dynamically inject exact 38mm x 25mm barcode sticker @page style
  const style = document.createElement("style");
  style.id = "dynamic-print-page-style";
  style.innerHTML = `@page { size: 38mm 25mm; margin: 0; }`;
  document.head.appendChild(style);

  window.print();

  // Clean up style override immediately after print dialog resolves
  document.body.classList.remove("print-mode-label");
  style.remove();

  // Release print lock after a delay to absorb touchscreen click events
  setTimeout(() => {
    isPrinting = false;
  }, 1500);
}

function closeLabels() {
  const overlay = document.getElementById("label-overlay");
  if (overlay) overlay.classList.remove("receipt-modal-visible");
  document.body.classList.remove("print-mode-label");
  // Clear labels container on close
  const container = document.getElementById("labels-container");
  if (container) container.innerHTML = "";
}

// Wrapper for inventory label button
async function printProductLabels(p) {
  const startNum = parseInt(p.barcode);
  const endNum = parseInt(p.barcode_end || p.barcode);
  if (isNaN(startNum)) {
    alert("Cannot print: Barcode must be numeric.");
    return;
  }
  printProductLabelsRange(p.name, startNum, endNum, p.price);
}

// Barcode fields are now auto-assigned
function initBarcodeAutoCalc() {
  const barcodeNote = document.getElementById("prod-barcode");
  if (barcodeNote)
    barcodeNote.closest(".form-group")?.setAttribute("style", "display:none");
}

// ===== SECRETARY HUB: CALENDAR & EMAIL ENGINE =====
let calMonth = new Date().getMonth();
let calYear = new Date().getFullYear();
let calEvents = [];
let calSelectedDate = new Date().toISOString().split("T")[0];

function loadSecretaryHub() {
  switchSecretaryView("calendar");
  // Auto-trigger a sync in the background when hub is opened
  fetchAuth(`${API_URL}/emails/fetch`, { method: "POST" }).catch(() => {});

  // Form handler is now bound directly in index.html via onsubmit
  const calForm = document.getElementById("form-cal-event");
  if (calForm) calForm._bound = true;
  const emailForm = document.getElementById("form-email-config");
  if (emailForm && !emailForm._bound) {
    emailForm.addEventListener("submit", handleEmailConfigSubmit);
    emailForm._bound = true;
  }
}

function switchSecretaryView(view) {
  document.getElementById("sec-calendar-view").style.display =
    view === "calendar" ? "block" : "none";
  document.getElementById("sec-inbox-view").style.display =
    view === "inbox" ? "block" : "none";
  const msgView = document.getElementById("sec-messages-view");
  if (msgView) msgView.style.display = view === "messages" ? "block" : "none";
  const dirView = document.getElementById("sec-directory-view");
  if (dirView) dirView.style.display = view === "directory" ? "block" : "none";
  const waView = document.getElementById("sec-whatsapp-view");
  if (waView) waView.style.display = view === "whatsapp" ? "block" : "none";
  const meetView = document.getElementById("sec-meet-view");
  if (meetView) {
    if (view === "meet") {
      meetView.style.position = "relative";
      meetView.style.visibility = "visible";
      meetView.style.height = "auto";
      meetView.style.display = "block";
    } else {
      meetView.style.position = "absolute";
      meetView.style.visibility = "hidden";
      meetView.style.height = "0";
      meetView.style.display = "none";
    }
  }

  const calBtn = document.getElementById("btn-sec-calendar");
  if (calBtn) calBtn.classList.toggle("active", view === "calendar");
  const inboxBtn = document.getElementById("btn-sec-inbox");
  if (inboxBtn) inboxBtn.classList.toggle("active", view === "inbox");
  const msgBtn = document.getElementById("btn-sec-messages");
  if (msgBtn) msgBtn.classList.toggle("active", view === "messages");
  const dirBtn = document.getElementById("btn-sec-directory");
  if (dirBtn) dirBtn.classList.toggle("active", view === "directory");
  const waBtn = document.getElementById("btn-sec-whatsapp");
  if (waBtn) waBtn.classList.toggle("active", view === "whatsapp");
  const meetBtn = document.getElementById("btn-sec-meet");
  if (meetBtn) meetBtn.classList.toggle("active", view === "meet");

  if (view === "calendar") renderCalendar();
  if (view === "inbox") {
    loadEmails();
    loadEmailConfig();
  }
  if (view === "messages") {
    loadStaffList();
    loadMessages();
  }
  if (view === "directory") renderStaffDirectory();
  if (view === "meet") loadMeetingOptions();
  if (view === "whatsapp") loadWhatsAppStatus();

  // Ensure webview pointer events are only active when on the meet tab
  const wv = document.getElementById("meet-frame");
  if (wv) {
    wv.style.pointerEvents = view === "meet" ? "auto" : "none";
  }

  // Track whether the Meet webview tab is active (used by barcode scanner bypass).
  window._webviewTabActive = view === "meet";

  // ALWAYS restore host focus after a view switch.
  if (window.electronAPI && window.electronAPI.forceFocus) {
    window.electronAPI.forceFocus();
  } else {
    window.focus();
    document.body.focus();
  }
}

async function loadMeetingOptions() {
  try {
    const today = new Date();
    const m = today.getMonth() + 1;
    const y = today.getFullYear();
    const todayStr = today.toISOString().split("T")[0];

    const res = await fetchAuth(
      `${API_URL}/calendar/events?month=${m}&year=${y}`,
    );
    const data = await res.json();

    const select = document.getElementById("meet-event-select");
    if (!select) return;

    select.innerHTML = '<option value="">-- Select a Meeting --</option>';

    const todaysEvents = (data.events || []).filter(
      (e) => e.event_date === todayStr,
    );
    if (todaysEvents.length === 0) {
      select.innerHTML =
        '<option value="">No meetings scheduled for today</option>';
    } else {
      todaysEvents.forEach((e) => {
        select.innerHTML += `<option value="${e.id}">${e.start_time || ""} - ${e.title}</option>`;
      });
    }

    // Listen to change to load existing minutes if any
    select.addEventListener("change", () => {
      const ev = todaysEvents.find((x) => x.id == select.value);
      const textarea = document.getElementById("meet-minutes-text");
      if (ev && textarea) {
        textarea.value = ev.minutes || "";
      } else if (textarea) {
        textarea.value = "";
      }
    });
  } catch (e) {
    console.error("Error loading meetings for minutes:", e);
  }
}

async function saveMeetingMinutes() {
  const select = document.getElementById("meet-event-select");
  const textarea = document.getElementById("meet-minutes-text");
  if (!select || !textarea) return;

  const eventId = select.value;
  const minutes = textarea.value.trim();

  if (!eventId) {
    alert("Please select a meeting from the dropdown first.");
    return;
  }

  try {
    const res = await fetchAuth(
      `${API_URL}/calendar/events/${eventId}/minutes`,
      {
        method: "POST",
        body: JSON.stringify({ minutes }),
      },
    );

    if (res.ok) {
      showToast(`Meeting minutes saved successfully!`, "success");
    } else {
      const data = await res.json();
      alert("Error: " + (data.error || "Failed to save minutes"));
    }
  } catch (e) {
    console.error("Save minutes error:", e);
    alert("Failed to connect to server.");
  }
}

function toggleMeetMinutes() {
  const floatPanel = document.getElementById("meet-minutes-float");
  if (!floatPanel) return;
  if (floatPanel.style.display === "none" || !floatPanel.style.display) {
    floatPanel.style.display = "block";
    if (typeof loadMeetingOptions === "function") loadMeetingOptions();
  } else {
    floatPanel.style.display = "none";
  }
}

// Drag logic for meet-minutes-float
setTimeout(() => {
  const floatPanel = document.getElementById("meet-minutes-float");
  const dragHandle = document.getElementById("meet-minutes-drag-handle");
  if (!floatPanel || !dragHandle) return;

  let isDragging = false;
  let offsetX, offsetY;

  dragHandle.addEventListener("mousedown", (e) => {
    // Don't drag if clicking the close button
    if (
      e.target.tagName.toLowerCase() === "button" ||
      e.target.closest("button")
    )
      return;
    isDragging = true;
    const rect = floatPanel.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    // Prevent text selection during drag
    e.preventDefault();
  });

  function onMouseMove(e) {
    if (!isDragging) return;
    // Make sure it doesn't go off-screen completely, but simple assignment is fine
    let newX = e.clientX - offsetX;
    let newY = e.clientY - offsetY;

    floatPanel.style.left = newX + "px";
    floatPanel.style.top = newY + "px";
    floatPanel.style.right = "auto"; // Remove right anchoring
  }

  function onMouseUp() {
    isDragging = false;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }
}, 1000);

function navigateCalendar(delta) {
  calMonth += delta;
  if (calMonth > 11) {
    calMonth = 0;
    calYear++;
  }
  if (calMonth < 0) {
    calMonth = 11;
    calYear--;
  }
  renderCalendar();
}

function goToToday() {
  calMonth = new Date().getMonth();
  calYear = new Date().getFullYear();
  calSelectedDate = new Date().toISOString().split("T")[0];
  renderCalendar();
}

async function renderCalendar() {
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  document.getElementById("cal-month-title").textContent =
    `${monthNames[calMonth]} ${calYear}`;

  // Fetch events for this month
  try {
    const m = calMonth + 1;
    const res = await fetchAuth(
      `${API_URL}/calendar/events?month=${m}&year=${calYear}`,
    );
    const data = await res.json();
    calEvents = data.events || [];
  } catch (e) {
    console.error("Calendar fetch error:", e);
    calEvents = [];
  }

  const grid = document.getElementById("calendar-grid");
  grid.innerHTML = "";

  const firstDay = new Date(calYear, calMonth, 1);
  let startDay = firstDay.getDay() - 1; // Monday=0
  if (startDay < 0) startDay = 6;

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const daysInPrev = new Date(calYear, calMonth, 0).getDate();
  const todayStr = new Date().toISOString().split("T")[0];
  const totalCells = Math.ceil((startDay + daysInMonth) / 7) * 7;

  for (let i = 0; i < totalCells; i++) {
    const cell = document.createElement("div");
    cell.className = "cal-day";
    let dateStr, dayNum;

    if (i < startDay) {
      dayNum = daysInPrev - startDay + i + 1;
      const pm = calMonth === 0 ? 12 : calMonth;
      const py = calMonth === 0 ? calYear - 1 : calYear;
      dateStr = `${py}-${String(pm).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
      cell.classList.add("other-month");
    } else if (i >= startDay + daysInMonth) {
      dayNum = i - startDay - daysInMonth + 1;
      const nm = calMonth === 11 ? 1 : calMonth + 2;
      const ny = calMonth === 11 ? calYear + 1 : calYear;
      dateStr = `${ny}-${String(nm).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
      cell.classList.add("other-month");
    } else {
      dayNum = i - startDay + 1;
      dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
    }

    if (dateStr === todayStr) cell.classList.add("today");
    if (dateStr === calSelectedDate) cell.classList.add("selected");

    const numEl = document.createElement("div");
    numEl.className = "cal-day-num";
    numEl.textContent = dayNum;
    cell.appendChild(numEl);

    // Show event dots
    const dayEvents = calEvents.filter((e) => e.event_date === dateStr);
    dayEvents.slice(0, 3).forEach((evt) => {
      const dot = document.createElement("div");
      dot.className = "cal-event-dot";
      dot.style.background = evt.color || "#4F46E5";
      dot.textContent = evt.title;
      cell.appendChild(dot);
    });
    if (dayEvents.length > 3) {
      const more = document.createElement("div");
      more.style.cssText =
        "font-size:0.6rem; color:var(--text-muted); padding-left:5px;";
      more.textContent = `+${dayEvents.length - 3} more`;
      cell.appendChild(more);
    }

    cell.dataset.date = dateStr;
    cell.onclick = () => selectCalendarDate(dateStr);
    grid.appendChild(cell);
  }

  showDayEvents(calSelectedDate);
}

function selectCalendarDate(dateStr) {
  calSelectedDate = dateStr;
  // Update highlight without re-fetching from API
  document
    .querySelectorAll(".cal-day")
    .forEach((d) => d.classList.remove("selected"));
  document.querySelectorAll(".cal-day").forEach((d) => {
    if (d.dataset && d.dataset.date === dateStr) d.classList.add("selected");
  });
  showDayEvents(dateStr);
  // Pre-fill the event modal date
  const dateInput = document.getElementById("cal-evt-date");
  if (dateInput) dateInput.value = dateStr;
}

function showDayEvents(dateStr) {
  const container = document.getElementById("cal-events-list");
  const title = document.getElementById("cal-events-title");
  const d = new Date(dateStr + "T12:00:00");
  const dayName = d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  title.innerHTML = `<i class="fa-solid fa-thumbtack"></i> Events for ${dayName}`;

  const dayEvents = calEvents.filter((e) => e.event_date === dateStr);
  if (dayEvents.length === 0) {
    container.innerHTML = `<p style="color:var(--text-muted); text-align:center; padding:20px;">No events scheduled for this day.</p>`;
    return;
  }

  container.innerHTML = "";
  dayEvents.forEach((evt) => {
    const card = document.createElement("div");
    card.className = "cal-event-card";
    card.style.borderLeftColor = evt.color || "#4F46E5";
    const timeStr = evt.start_time
      ? `${evt.start_time}${evt.end_time ? " - " + evt.end_time : ""}`
      : "All Day";
    const typeColors = {
      Meeting: "#4F46E5",
      Appointment: "#10B981",
      Deadline: "#EF4444",
      Reminder: "#F59E0B",
      Holiday: "#EC4899",
      Other: "#8B5CF6",
    };
    card.innerHTML = `
            <div style="flex:1;">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                    <span style="background:${typeColors[evt.event_type] || "#4F46E5"}22; color:${typeColors[evt.event_type] || "#4F46E5"}; padding:2px 8px; border-radius:4px; font-size:0.7rem; font-weight:600;">${evt.event_type}</span>
                    <span style="font-size:0.8rem; color:var(--text-muted);"><i class="fa-regular fa-clock"></i> ${timeStr}</span>
                </div>
                <h4 style="margin:0 0 4px 0; font-size:1rem;">${evt.title}</h4>
                ${evt.description ? `<p style="font-size:0.85rem; color:var(--text-muted); margin:0;">${evt.description}</p>` : ""}
            </div>
            <div style="display:flex; flex-direction:column; gap:5px; align-items:flex-end;">
                ${evt.event_type === "Meeting" ? `<button class="sm-btn" style="background:#4F46E5; color:white; border:none;" onclick="openMinutesModal(${evt.id})" title="Meeting Minutes"><i class="fa-solid fa-pen-to-square"></i> Minutes</button>` : ""}
                <button class='sm-btn danger' onclick="deleteCalEvent(${evt.id})" title="Delete"><i class="fa-solid fa-trash"></i></button>
            </div>
        `;
    container.appendChild(card);
  });
}

async function handleCalEventSubmit(e) {
  e.preventDefault();

  // STEP 1: Read all form values
  const title = document.getElementById("cal-evt-title").value.trim();
  const event_date = document.getElementById("cal-evt-date").value;
  const event_type = document.getElementById("cal-evt-type").value;
  const start_time = document.getElementById("cal-evt-start").value;
  const end_time = document.getElementById("cal-evt-end").value;
  const description = document.getElementById("cal-evt-desc").value;
  const color = document.getElementById("cal-evt-color").value;

  // STEP 2: Validate required fields
  if (!title) {
    alert("ERROR: Title is empty. Please enter an event title.");
    return;
  }
  if (!event_date) {
    alert("ERROR: Date is empty. Please pick a date.");
    return;
  }

  const payload = {
    title,
    event_type,
    event_date,
    start_time,
    end_time,
    description,
    color,
  };

  // STEP 3: Check token
  const token = localStorage.getItem("jomish_token");
  if (!token) {
    alert("ERROR: No login token found. You are not logged in.");
    return;
  }

  // STEP 4: Send to server
  try {
    const res = await fetchAuth(`${API_URL}/calendar/events`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    // STEP 5: Check HTTP status
    if (res.ok) {
      document.getElementById("cal-event-modal").classList.add("hidden");
      e.target.reset();
      calSelectedDate = event_date;
      const [y, m] = event_date.split("-");
      calYear = parseInt(y, 10);
      calMonth = parseInt(m, 10) - 1;
      await renderCalendar();
      showToast("Calendar event created!", "success");
    } else {
      let errMsg = "Unknown server error (status " + res.status + ")";
      try {
        const d = await res.json();
        errMsg = d.error || errMsg;
      } catch (je) {}
      alert("SERVER ERROR: " + errMsg);
    }
  } catch (err) {
    alert(
      "NETWORK ERROR: Could not reach server.\nDetails: " +
        err.message +
        "\nAPI URL: " +
        API_URL,
    );
  }
}

async function deleteCalEvent(id) {
  if (!confirm("Delete this event?")) return;
  try {
    const res = await fetchAuth(`${API_URL}/calendar/events/${id}`, {
      method: "DELETE",
    });
    if (res.ok) renderCalendar();
  } catch (e) {
    console.error("Delete event error:", e);
  }
}

// ===== MEETING MINUTES LOGIC =====
function openMinutesModal(eventId) {
  const evt = calEvents.find((e) => e.id === eventId);
  if (!evt) return;

  document.getElementById("minutes-evt-id").value = eventId;
  document.getElementById("minutes-modal-title").textContent =
    `Minutes: ${evt.title}`;

  const timeStr = evt.start_time
    ? `${evt.start_time}${evt.end_time ? " - " + evt.end_time : ""}`
    : "All Day";
  document.getElementById("minutes-modal-subtitle").innerHTML =
    `<i class="fa-solid fa-calendar"></i> ${evt.event_date} | <i class="fa-regular fa-clock"></i> ${timeStr}`;

  document.getElementById("minutes-content").value = evt.minutes || "";

  document.getElementById("minutes-modal").classList.remove("hidden");
}

document
  .getElementById("btn-save-minutes")
  ?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-save-minutes");
    btn.disabled = true;
    btn.textContent = "Saving...";

    const id = document.getElementById("minutes-evt-id").value;
    const minutes = document.getElementById("minutes-content").value;

    try {
      const res = await fetchAuth(`${API_URL}/calendar/events/${id}/minutes`, {
        method: "POST",
        body: JSON.stringify({ minutes }),
      });

      if (res.ok) {
        alert("Minutes saved successfully!");
        const evt = calEvents.find((e) => e.id == id);
        if (evt) evt.minutes = minutes;
        document.getElementById("minutes-modal").classList.add("hidden");
      } else {
        alert("Error saving minutes.");
      }
    } catch (e) {
      alert("Network error saving minutes.");
    }

    btn.disabled = false;
    btn.textContent = "Save Minutes";
  });

document
  .getElementById("btn-download-minutes")
  ?.addEventListener("click", () => {
    const id = document.getElementById("minutes-evt-id").value;
    const evt = calEvents.find((e) => e.id == id);
    if (!evt) return;

    const minutes = document.getElementById("minutes-content").value;
    if (!minutes.trim()) {
      alert("Please save some minutes before downloading.");
      return;
    }

    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF();

      doc.setFontSize(18);
      doc.text("Meeting Minutes", 14, 20);

      doc.setFontSize(12);
      doc.setTextColor(100);
      doc.text(`Subject: ${evt.title}`, 14, 30);
      doc.text(`Date: ${evt.event_date}`, 14, 38);
      const timeStr = evt.start_time
        ? `${evt.start_time}${evt.end_time ? " - " + evt.end_time : ""}`
        : "All Day";
      doc.text(`Time: ${timeStr}`, 14, 46);

      doc.line(14, 50, 196, 50); // Horizontal line

      doc.setFontSize(11);
      doc.setTextColor(0);

      // Handle multi-line text wrapping automatically
      const splitText = doc.splitTextToSize(minutes, 180);
      doc.text(splitText, 14, 60);

      doc.save(
        `Meeting_Minutes_${evt.event_date}_${evt.title.replace(/[^a-z0-9]/gi, "_")}.pdf`,
      );
    } catch (e) {
      console.error("PDF Generation Error:", e);
      alert("Error generating PDF. Make sure the jsPDF library is loaded.");
    }
  });

// ===== EMAIL INBOX =====
async function loadEmails() {
  try {
    const res = await fetchAuth(`${API_URL}/emails`);
    const data = await res.json();
    const emails = data.emails || [];
    const unread = data.unread_count || 0;

    document.getElementById("email-total-count").textContent = emails.length;
    document.getElementById("email-unread-count").textContent = unread;
    const badge = document.getElementById("unread-badge");
    if (badge) {
      badge.textContent = unread;
      badge.style.display = unread > 0 ? "inline" : "none";
    }

    window.unreadEmails = unread;
    if (typeof updateSecretaryGlobalBadge === "function")
      updateSecretaryGlobalBadge();

    const tbody = document.getElementById("email-inbox-tbody");
    if (emails.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="4" style="text-align:center; padding:40px; color:#94A3B8;">No emails yet. Click "Fetch New Emails" to pull from Gmail.</td></tr>';
      return;
    }

    tbody.innerHTML = "";
    emails.forEach((em) => {
      const tr = document.createElement("tr");
      tr.className = `email-row ${em.is_read ? "read" : "unread"}`;
      tr.innerHTML = `
                <td style="width:30px; text-align:center;"></td>
                <td style="max-width:180px;"><strong style="display:block; font-size:0.88rem;">${em.from_name || em.from_address}</strong><span style="font-size:0.72rem; color:var(--text-muted);">${em.from_address}</span></td>
                <td style="max-width:350px;"><div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${em.subject}</div></td>
                <td style="white-space:nowrap; font-size:0.8rem; color:var(--text-muted);">${formatDisplayDate(em.received_at)}</td>
            `;
      tr.onclick = () => openEmailPreview(em);
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error("Load emails error:", e);
  }
}

async function openEmailPreview(em) {
  window._currentEmail = em;

  // Populate Capsule
  document.getElementById("capsule-subject").textContent = em.subject;
  document.getElementById("capsule-from").textContent =
    em.from_name || em.from_address;
  document.getElementById("capsule-date").textContent = formatDisplayDate(
    em.received_at,
  );
  document.getElementById("capsule-body").textContent =
    em.body_preview || "(No content)";

  // Show Reading View
  document.getElementById("capsule-read-view").style.display = "block";
  document.getElementById("capsule-reply-view").style.display = "none";
  document.getElementById("btn-capsule-reply").style.display = "block";

  // Slide in
  document.getElementById("email-capsule-panel").classList.add("active");

  // Mark as read in background
  if (!em.is_read) {
    try {
      await fetchAuth(`${API_URL}/emails/${em.id}/read`, { method: "PATCH" });
      loadEmails(); // Refresh list to update UI count
    } catch (e) {}
  }
}

function closeEmailCapsule() {
  document.getElementById("email-capsule-panel").classList.remove("active");
}

function toggleCapsuleReply() {
  const readView = document.getElementById("capsule-read-view");
  const replyView = document.getElementById("capsule-reply-view");
  const em = window._currentEmail;

  if (replyView.style.display === "none") {
    // Switch to Reply
    document.getElementById("reply-to").value = em.from_address;
    document.getElementById("reply-subject").value = `Re: ${em.subject}`;
    document.getElementById("reply-body").value =
      `\n\n--- Original Message ---\nFrom: ${em.from_address}\nDate: ${formatDisplayDate(em.received_at)}\n\n${em.body_preview}`;

    readView.style.display = "none";
    replyView.style.display = "block";
    document.getElementById("btn-capsule-reply").style.display = "none";
    document.getElementById("reply-body").focus();
    window._isBlastMode = false;
  } else {
    // Back to Reading
    readView.style.display = "block";
    replyView.style.display = "none";
    document.getElementById("btn-capsule-reply").style.display = "block";
  }
}

// handleEmailReplySubmit() is defined below with blast-mode support

function bridgeStaffEmail(email, name, content) {
  // Populate Capsule with Staff Info
  document.getElementById("reply-to").value = email;
  document.getElementById("reply-subject").value =
    `Follow-up: Internal Message for ${name}`;
  document.getElementById("reply-body").value =
    `Hi ${name.split(" ")[0]},\n\nI'm following up on our internal message:\n"${content}"\n\n---\nBest Regards,\n${localStorage.getItem("jomish_name")}`;

  // Switch to Reply View in Capsule
  document.getElementById("capsule-read-view").style.display = "none";
  document.getElementById("capsule-reply-view").style.display = "block";
  document.getElementById("btn-capsule-reply").style.display = "none";

  // Open Capsule
  document.getElementById("email-capsule-panel").classList.add("active");
}

async function fetchNewEmails(e) {
  const btn =
    e && e.target
      ? e.target
      : document.querySelector('[onclick*="fetchNewEmails"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Syncing Gmail...";
  }
  try {
    const res = await fetchAuth(`${API_URL}/emails/fetch`, { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || "Inbox synced.", "success");
      loadEmails();
    } else {
      showToast(data.error || "Failed to sync emails.", "danger");
    }
  } catch (e) {
    showToast(`Network error. Check server connection.`, "danger");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-inbox"></i> Sync Inbox';
    }
  }
}

async function loadEmailConfig() {
  try {
    const res = await fetchAuth(`${API_URL}/settings/email`);
    const data = await res.json();
    const statusEl = document.getElementById("email-connection-status");
    if (data.configured) {
      statusEl.innerHTML = '<i class="fa-solid fa-check"></i> ' + data.email;
      statusEl.style.color = "var(--success)";
    } else {
      statusEl.textContent = "Not Configured";
      statusEl.style.color = "var(--text-muted)";
    }
  } catch (e) {
    console.error("Email config load error:", e);
  }
}

async function handleEmailConfigSubmit(e) {
  e.preventDefault();
  const email = document.getElementById("email-cfg-address").value;
  const pwd = document.getElementById("email-cfg-password").value;
  const resendKey = document.getElementById("email-cfg-resend-key").value;

  // Only require password if one isn't already set, or if we are changing it
  const payload = { email };
  if (pwd) payload.app_password = pwd;
  if (resendKey) payload.resend_api_key = resendKey;

  try {
    const res = await fetchAuth(`${API_URL}/settings/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      alert("Gmail configuration saved!");
      document.getElementById("email-config-modal").classList.add("hidden");
      e.target.reset();
      loadEmailConfig();
    } else {
      const d = await res.json();
      alert("" + (d.error || "Failed to save configuration."));
    }
  } catch (err) {
    alert("Network error");
  }
}

// ===== INTERNAL MESSAGING ENGINE =====
let _receptionistId = null;

async function loadStaffList() {
  try {
    const res = await fetchAuth(`${API_URL}/employees`);
    const data = await res.json();

    const selInternal = document.getElementById("msg-to-id");
    const selCapsule = document.getElementById("capsule-staff-select");

    const htmlInternal = ['<option value="">-- Search Directory --</option>'];
    const htmlCapsule = ['<option value="">-- Search Directory --</option>'];

    (data.employees || []).forEach((emp) => {
      const emailInfo = emp.email ? ` - ${emp.email}` : " (No Email Set)";
      const label = `${emp.first_name} ${emp.last_name} (${emp.role || "Staff"})${emailInfo}`;

      htmlInternal.push(`<option value="${emp.id}">${label}</option>`);
      if (emp.email) {
        htmlCapsule.push(`<option value="${emp.email}">${label}</option>`);
      } else {
        htmlCapsule.push(`<option value="" disabled>${label}</option>`);
      }
    });

    if (selInternal) selInternal.innerHTML = htmlInternal.join("");
    if (selCapsule) selCapsule.innerHTML = htmlCapsule.join("");
  } catch (e) {
    console.error("Staff list error:", e);
  }
}

function openNewEmailCapsule() {
  // Reset for Single Message
  document.getElementById("reply-to").value = "";
  document.getElementById("reply-to").classList.remove("dimmed-input");
  document.getElementById("reply-subject").value = "";
  document.getElementById("reply-body").value = "";
  document.getElementById("capsule-staff-select").value = "";

  // Show search
  document.getElementById("capsule-recipient-group").style.display = "block";

  document.getElementById("capsule-read-view").style.display = "none";
  document.getElementById("capsule-reply-view").style.display = "block";
  document.getElementById("btn-capsule-reply").style.display = "none";

  // Set Header
  document.getElementById("capsule-reply-view").querySelector("h2").innerHTML =
    '<i class="fa-solid fa-envelope"></i> Compose New Email';

  // Open Panel
  document.getElementById("email-capsule-panel").classList.add("active");
  loadStaffList();
  window._isBlastMode = false;
}

function openBlastEmailCapsule() {
  // Set Blast Mode
  document.getElementById("reply-to").value =
    '<i class="fa-solid fa-bullhorn"></i> ALL ACTIVE STAFF (BCC Blast)';
  document.getElementById("reply-to").classList.add("dimmed-input");
  document.getElementById("reply-subject").value = "";
  document.getElementById("reply-body").value = "";

  // Hide Search since it's a blast
  document.getElementById("capsule-recipient-group").style.display = "none";

  document.getElementById("capsule-read-view").style.display = "none";
  document.getElementById("capsule-reply-view").style.display = "block";
  document.getElementById("btn-capsule-reply").style.display = "none";

  // Set Header
  document.getElementById("capsule-reply-view").querySelector("h2").innerHTML =
    '<i class="fa-solid fa-bullhorn"></i> Mass Staff Email Blast';

  // Open Panel
  document.getElementById("email-capsule-panel").classList.add("active");

  // Set flag for handler
  window._isBlastMode = true;
}

async function handleEmailReplySubmit(e) {
  e.preventDefault();
  const btn = document.getElementById("btn-send-reply");
  btn.disabled = true;
  btn.textContent = "Processing...";

  const isBlast = window._isBlastMode === true;
  const endpoint = isBlast
    ? `${API_URL}/emails/blast`
    : `${API_URL}/emails/send`;

  const payload = {
    subject: document.getElementById("reply-subject").value,
    body: document.getElementById("reply-body").value,
  };

  if (!isBlast) payload.to = document.getElementById("reply-to").value;

  try {
    const res = await fetchAuth(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      alert(
        isBlast ? "Staff Blast sent successfully!" : "Email sent successfully!",
      );
      closeEmailCapsule();
      e.target.reset();
    } else {
      const data = await res.json();
      alert("Failed: " + (data.error || "Check configuration"));
    }
  } catch (err) {
    alert("Network error.");
  } finally {
    btn.disabled = false;
    btn.textContent = isBlast ? "Send Blast" : "Send Reply";
    window._isBlastMode = false; // Reset
  }
}

async function loadMessages() {
  try {
    const res = await fetchAuth(`${API_URL}/messages`);
    const data = await res.json();
    const msgs = data.messages || [];

    const container = document.getElementById("sec-messages-list");
    if (!container) return;

    // Update badge
    const userId = parseInt(localStorage.getItem("jomish_user_id"));
    const unread = msgs.filter((m) => m.to_id === userId && !m.is_read).length;
    const badge = document.getElementById("msg-badge");
    if (badge) {
      badge.textContent = unread;
      badge.style.display = unread > 0 ? "inline" : "none";
    }

    if (msgs.length === 0) {
      container.innerHTML =
        '<p style="color:var(--text-muted); text-align:center; padding:30px;">No messages yet. Send your first message to a staff member!</p>';
      return;
    }

    container.innerHTML = "";
    msgs.forEach((m) => {
      const isSent = m.from_id === userId;
      const otherName = isSent
        ? `${m.to_first || ""} ${m.to_last || ""}`
        : `${m.from_first || ""} ${m.from_last || ""}`;
      const otherRole = isSent ? m.to_role : m.from_role;
      const card = document.createElement("div");
      card.className = "msg-card";
      card.style.cssText = `background:var(--background); border-radius:10px; padding:14px 16px; border-left:4px solid ${isSent ? "#10B981" : "#4F46E5"}; ${!m.is_read && !isSent ? "border:1px solid rgba(79,70,229,0.4);" : ""}`;
      const otherEmail = isSent ? m.to_email : m.from_email;

      card.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="font-size:0.7rem; background:${isSent ? "rgba(16,185,129,0.15)" : "rgba(79,70,229,0.15)"}; color:${isSent ? "#10B981" : "#4F46E5"}; padding:2px 8px; border-radius:4px; font-weight:600;">${isSent ? "SENT" : "RECEIVED"}</span>
                        <strong style="font-size:0.9rem;">${otherName.trim()}</strong>
                        <span style="font-size:0.7rem; color:#94A3B8;">${otherRole || ""}</span>
                    </div>
                    <span style="font-size:0.72rem; color:#94A3B8;">${formatDisplayDate(m.created_at)}</span>
                </div>
                ${m.subject ? `<div style="font-size:0.82rem; font-weight:600; margin-bottom:4px; color:var(--text);">${m.subject}</div>` : ""}
                <p style="font-size:0.88rem; color:var(--text); line-height:1.5; margin:0;">${m.content}</p>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;">
                    ${!m.is_read && !isSent ? '<div style="font-size:0.65rem; color:var(--primary); font-weight:600;">●  NEW</div>' : "<div></div>"}
                    ${otherEmail ? `<button class="sm-btn secondary" onclick="bridgeStaffEmail('${otherEmail}', '${otherName.trim().replace(/'/g, "\\'")}', '${m.content.replace(/'/g, "\\'")}')"><i class="fa-solid fa-envelope"></i> Send Work Email</button>` : ""}
                </div>
            `;
      // Mark as read on click
      if (!m.is_read && !isSent) {
        card.style.cursor = "pointer";
        card.onclick = async () => {
          await fetchAuth(`${API_URL}/messages/${m.id}/read`, {
            method: "PATCH",
          });
          loadMessages();
        };
      }
      container.appendChild(card);
    });
  } catch (e) {
    console.error("Load messages error:", e);
  }
}

async function renderStaffDirectory() {
  try {
    const res = await fetchAuth(`${API_URL}/employees`);
    const data = await res.json();
    window._staffDirectory = data.employees || [];
    searchStaffDirectory(); // Initial render
  } catch (e) {
    console.error("Directory error:", e);
  }
}

function searchStaffDirectory() {
  const query = document.getElementById("directory-search").value.toLowerCase();
  const tbody = document.getElementById("staff-directory-tbody");
  if (!tbody) return;

  tbody.innerHTML = "";
  const filtered = (window._staffDirectory || []).filter((emp) => {
    if (!emp.is_active) return false;
    const searchStr =
      `${emp.first_name} ${emp.last_name} ${emp.email} ${emp.role} ${emp.department}`.toLowerCase();
    return searchStr.includes(query);
  });

  if (filtered.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="4" style="text-align:center; padding:30px; color:var(--text-muted);">No staff found matching your search.</td></tr>';
    return;
  }

  filtered.forEach((emp) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
            <td>
                <div style="display:flex; align-items:center; gap:10px;">
                    <div style="width:32px; height:32px; border-radius:50%; background:${emp.profile_color || "var(--primary)"}; display:flex; align-items:center; justify-content:center; color:white; font-size:0.8rem; font-weight:700;">
                        ${emp.first_name[0]}${emp.last_name[0]}
                    </div>
                    <strong>${emp.first_name} ${emp.last_name}</strong>
                </div>
            </td>
            <td>
                <div style="font-size:0.88rem;">${emp.role || "Staff"}</div>
                <div style="font-size:0.7rem; color:var(--text-muted);">${emp.department || "Operations"}</div>
            </td>
            <td>
                <code style="font-size:0.85rem; color:var(--primary);">${emp.email || '<span style="color:var(--danger);">[ No Email Registered ]</span>'}</code>
            </td>
            <td>
                ${emp.email ? `<button class="sm-btn primary" onclick="quickEmail('${emp.email}')"><i class="fa-solid fa-envelope"></i> Email</button>` : ""}
            </td>
        `;
    tbody.appendChild(tr);
  });
}

function quickEmail(email) {
  openNewEmailCapsule();
  document.getElementById("reply-to").value = email;
}

async function handleSendMessage(e) {
  e.preventDefault();
  const payload = {
    to_id: document.getElementById("msg-to-id").value,
    subject: document.getElementById("msg-subject").value,
    content: document.getElementById("msg-content").value,
  };
  try {
    const res = await fetchAuth(`${API_URL}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      alert("Message sent!");
      e.target.reset();
      loadMessages();
    } else {
      const d = await res.json();
      alert("" + (d.error || "Failed to send"));
    }
  } catch (err) {
    alert("Network error");
  }
}

// Dashboard: Load messages from front desk (for non-secretary staff)
async function loadDeskMessages() {
  const panel = document.getElementById("desk-messages-panel");
  if (!panel) return;

  // Only show for non-secretary roles
  if (USER_ROLE === "Receptionist") {
    panel.style.display = "none";
    return;
  }

  try {
    const res = await fetchAuth(`${API_URL}/messages`);
    const data = await res.json();
    const msgs = data.messages || [];

    const userId = parseInt(localStorage.getItem("jomish_user_id"));
    const received = msgs.filter((m) => m.to_id === userId);
    if (received.length === 0) {
      panel.style.display = "none";
      return;
    }

    panel.style.display = "block";
    const unread = received.filter((m) => !m.is_read).length;
    const badge = document.getElementById("dash-msg-badge");
    if (badge) {
      badge.textContent = unread;
      badge.style.display = unread > 0 ? "inline" : "none";
    }

    // Find the receptionist ID for reply
    const receptionists = msgs.filter((m) => m.from_role === "Receptionist");
    if (receptionists.length > 0) _receptionistId = receptionists[0].from_id;

    const list = document.getElementById("dash-messages-list");
    list.innerHTML = "";
    received.forEach((m) => {
      const card = document.createElement("div");
      card.style.cssText = `background:var(--background); border-radius:8px; padding:14px; border-left:3px solid ${m.is_read ? "var(--border)" : "var(--primary)"}; cursor:pointer;`;
      card.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <strong style="font-size:0.88rem; color:${m.is_read ? "var(--text-muted)" : "var(--text)"};">${m.from_first || "Front Desk"} ${m.from_last || ""}</strong>
                    <span style="font-size:0.7rem; color:#94A3B8;">${formatDisplayDate(m.created_at)}</span>
                </div>
                ${m.subject ? `<div style="font-size:0.8rem; font-weight:600; color:var(--primary); margin-bottom:4px;">${m.subject}</div>` : ""}
                <p style="font-size:0.85rem; color:var(--text); margin:0; line-height:1.4;">${m.content}</p>
                ${!m.is_read ? '<div style="font-size:0.6rem; color:var(--primary); margin-top:4px; font-weight:700;">●  UNREAD — click to mark as read</div>' : ""}
            `;
      if (!m.is_read) {
        card.onclick = async () => {
          await fetchAuth(`${API_URL}/messages/${m.id}/read`, {
            method: "PATCH",
          });
          loadDeskMessages();
        };
      }
      list.appendChild(card);
    });
  } catch (e) {
    console.error("Desk messages error:", e);
  }
}

async function handleReplyToDesk(e) {
  e.preventDefault();
  if (!_receptionistId) {
    // Try to find the receptionist from employees
    try {
      const res = await fetchAuth(`${API_URL}/employees`);
      const data = await res.json();
      const rec = (data.employees || []).find(
        (emp) => emp.role === "Receptionist" && emp.is_active,
      );
      if (rec) _receptionistId = rec.id;
      else {
        alert("No active Receptionist found in the system.");
        return;
      }
    } catch (e) {
      alert("Could not find Receptionist.");
      return;
    }
  }
  const payload = {
    to_id: _receptionistId,
    subject: document.getElementById("reply-msg-subject").value,
    content: document.getElementById("reply-msg-content").value,
  };
  try {
    const res = await fetchAuth(`${API_URL}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      alert("Reply sent to Front Desk!");
      document.getElementById("reply-msg-modal").classList.add("hidden");
      e.target.reset();
      loadDeskMessages();
    } else {
      const d = await res.json();
      alert("" + (d.error || "Failed to send"));
    }
  } catch (err) {
    alert("Network error");
  }
}

// Register messaging form handlers
document.addEventListener("DOMContentLoaded", () => {
  const sendForm = document.getElementById("form-send-msg");
  if (sendForm) sendForm.addEventListener("submit", handleSendMessage);
  const replyForm = document.getElementById("form-reply-msg");
  if (replyForm) replyForm.addEventListener("submit", handleReplyToDesk);
});

// ===== DATA LOSS WARNING (after restore from backup) =====
async function checkDataLossWarning() {
  try {
    const res = await fetchAuth(`${API_URL}/system-meta/data_loss_warning`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.value) return;

    // Don't show again if dismissed this session
    if (sessionStorage.getItem("data_loss_dismissed")) return;

    // Show warning banner
    const banner = document.createElement("div");
    banner.id = "data-loss-banner";
    banner.style.cssText = `
            position:fixed;top:0;left:0;right:0;z-index:99998;
            background:linear-gradient(135deg,#dc2626,#b91c1c);color:white;
            padding:16px 24px;font-size:0.9rem;text-align:center;
            box-shadow:0 4px 20px rgba(0,0,0,0.3);display:flex;
            align-items:center;justify-content:center;gap:12px;
        `;
    banner.innerHTML = `
            <span style="font-size:1.4rem"><i class="fa-solid fa-triangle-exclamation"></i></span>
            <span><strong>System Restored from Backup.</strong> ${data.value}</span>
            <button onclick="dismissDataLoss()" style="
                background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);
                color:white;padding:6px 16px;border-radius:8px;cursor:pointer;
                font-size:0.8rem;font-weight:600;margin-left:12px;
            ">Acknowledge</button>
        `;
    document.body.appendChild(banner);
  } catch (e) {
    /* silent */
  }
}

function dismissDataLoss() {
  const el = document.getElementById("data-loss-banner");
  if (el) el.remove();
  sessionStorage.setItem("data_loss_dismissed", "1");
  // Clear the warning from DB
  fetchAuth(`${API_URL}/system-meta/data_loss_warning`, {
    method: "DELETE",
  }).catch(() => {});
}

// ===== SECRETARY GLOBAL BADGE LOGIC =====
window.unreadEmails = 0;
window.unreadWhatsApp = 0;

function updateSecretaryGlobalBadge() {
  const badge = document.getElementById("sec-global-badge");
  if (!badge) return;
  const total = (window.unreadEmails || 0) + (window.unreadWhatsApp || 0);
  if (total > 0) {
    badge.textContent = total;
    badge.style.display = "inline";
  } else {
    badge.style.display = "none";
  }
}

async function fetchGlobalUnreadEmails() {
  try {
    const res = await fetchAuth(`${API_URL}/emails`);
    const data = await res.json();
    window.unreadEmails = data.unread_count || 0;
    updateSecretaryGlobalBadge();
  } catch (e) {}
}

document.addEventListener("DOMContentLoaded", () => {
  // Initial fetch for emails if permission allows
  setTimeout(() => {
    if (USER_PERMISSIONS && USER_PERMISSIONS.can_see_secretary) {
      fetchGlobalUnreadEmails();
    }
  }, 1500);

  // WhatsApp unread listener is now bound dynamically when the webview is created.
});

// Global Barcode Scanner Logic (Hardware)
function initGlobalScanner() {

  let barcodeBuffer = "";
  let lastKeyTime = 0;
  let isScanning = false;

  // Use capture phase (true) to intercept keystrokes BEFORE they reach input elements
  window.addEventListener(
    "keydown",
    async (e) => {
      // FIX: Bypass barcode scanner if a webview tab (WhatsApp / Meet) is active.
      // Previously used waView.style.display check which was fragile and could be
      // wrong during display transitions. Now uses a reliable flag set by switchSecretaryView.
      if (window._webviewTabActive) {
        return;
      }

      // Prevent auto-repeat from triggering scanner logic when holding a key
      if (e.repeat) {
        barcodeBuffer = "";
        return;
      }

      // Ignore modifier keys but reset buffer just in case
      if (!e || !e.key) return;
      if (e.key.length !== 1 && e.key !== "Enter") {
        barcodeBuffer = "";
        return;
      }

      const currentTime = Date.now();
      const timeDiff = currentTime - lastKeyTime;
      lastKeyTime = currentTime;

      // Scanners typically fire keys extremely fast (< 40ms apart).
      // If the time diff is > 40ms, it's likely human typing or a new scan.
      if (timeDiff > 40) {
        // Too slow for a scanner, reset buffer
        barcodeBuffer = e.key.length === 1 ? e.key : "";
        return;
      }

      if (e.key !== "Enter") {
        barcodeBuffer += e.key;
      } else {
        if (barcodeBuffer.length >= 3) {
          // We have a barcode!
          e.preventDefault();
          e.stopPropagation();

          const finalCode = barcodeBuffer;
          barcodeBuffer = "";

          // Remove the scanned characters from the focused input if they leaked in
          if (document.activeElement) {
            const el = document.activeElement;
            if (
              (el.tagName === "INPUT" || el.tagName === "TEXTAREA") &&
              !el.readOnly
            ) {
              if (el.value && el.value.length >= finalCode.length) {
                const valStr = String(el.value);
                if (valStr.endsWith(finalCode)) {
                  el.value = valStr.slice(0, -finalCode.length);
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                }
              }
            }
          }

          await handleGlobalBarcode(finalCode);
        } else {
          barcodeBuffer = "";
        }
      }
    },
    true,
  ); // Important: capture phase
}

async function handleGlobalBarcode(code) {

  // 1. Intercept for Scan Session Modal (adding barcodes to a new product)
  const scanSession = document.getElementById("scan-session-modal");
  if (scanSession && !scanSession.classList.contains("hidden")) {
    const inputEl = document.getElementById("scan-input");
    if (inputEl) {
      inputEl.value = code;
      if (typeof window.submitScanInput === "function") {
        window.submitScanInput();
      }
    }
    return;
  }

  // 2. Intercept for Edit Product Modal
  const editModal = document.getElementById("edit-product-modal");
  if (editModal && !editModal.classList.contains("hidden")) {
    const editBarcodeEl = document.getElementById("edit-prod-barcode");
    if (editBarcodeEl) {
      editBarcodeEl.value = code;
    }
    return;
  }

  // Check if POS terminal is the active section
  const posSection = document.getElementById("pos-terminal");
  const isPOSActive = posSection && posSection.classList.contains("active");

  if (isPOSActive) {
    // Route through the local POS handler which validates unique barcodes and manages cart
    await handleBarcodeScan(code);
    return;
  }

  // For non-POS contexts, use the server API (handles employee attendance + product lookup)
  try {
    const res = await fetchAuth(`${API_URL}/scan/global`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    if (res.ok) {
      const result = await res.json();

      if (result.type === "EMPLOYEE") {
        // Non-blocking toast for attendance scans
        showToast(
          result.message,
          result.action === "IN" ? "success" : "warning",
        );
        if (USER_PERMISSIONS.can_see_attendance) loadAttendance();
        loadDashboard();
      } else if (result.type === "PRODUCT") {
        const product = result.data;
        showToast(
          `${product.name} — UGX ${Number(product.price).toLocaleString()} (Stock: ${product.stock})`,
          "info",
        );
      }
    } else {
      // Only warn on long codes that are clearly deliberate scans
      if (code.length > 3) console.warn("[SCANNER] Unrecognized code:", code);
    }
  } catch (err) {
    console.error("[SCANNER] Global scan error:", err);
  }
}

async function loadCredits() {
  try {
    const res = await fetchAuth(`${API_URL}/credits`);
    if (res.ok) {
      const data = await res.json();
      const container = document.getElementById("credits-list-container");
      if (!container) return;
      container.innerHTML = "";

      const groups = {};
      data.credits.forEach((c) => {
        const name = c.buyer_name || "Unknown";
        if (!groups[name]) {
          groups[name] = {
            buyer_name: name,
            buyer_phone: c.buyer_phone || "",
            total_balance: 0,
            latest_date: new Date(0),
            transactions: [],
          };
        }
        groups[name].total_balance += Number(c.balance || 0);
        groups[name].transactions.push(c);

        // Track the latest transaction date for sorting and updating phone number
        const d = new Date(String(c.created_at).replace(" ", "T"));
        if (!isNaN(d) && d > groups[name].latest_date) {
          groups[name].latest_date = d;
          if (c.buyer_phone) groups[name].buyer_phone = c.buyer_phone;
        }
      });

      const sortedGroups = Object.values(groups).sort(
        (a, b) => b.latest_date - a.latest_date,
      );
      window.creditGroups = groups; // Store globally for printStatement

      if (sortedGroups.length === 0) {
        container.innerHTML =
          '<div style="text-align:center; padding:30px; color:#94A3B8;">No credit records found.</div>';
        return;
      }

      let grandTotal = 0;
      sortedGroups.forEach((g) => {
        if (g.total_balance > 0) grandTotal += g.total_balance;
      });

      const summaryDiv = document.createElement("div");
      summaryDiv.style.padding = "15px";
      summaryDiv.style.marginBottom = "15px";
      summaryDiv.style.borderRadius = "8px";
      summaryDiv.style.background = "rgba(239, 68, 68, 0.05)";
      summaryDiv.style.border = "1px solid rgba(239, 68, 68, 0.2)";
      summaryDiv.style.display = "flex";
      summaryDiv.style.justifyContent = "space-between";
      summaryDiv.style.alignItems = "center";
      summaryDiv.innerHTML = `
                <div style="font-weight:700; font-size:1.05rem; color:var(--text);">Grand Total Outstanding</div>
                <div style="font-weight:800; font-size:1.25rem; color:#EF4444;">UGX ${grandTotal.toLocaleString()}</div>
            `;
      container.appendChild(summaryDiv);

      sortedGroups.forEach((g) => {
        // If they have zero balance, maybe style it differently, but still allow statement printing
        const balanceColor = g.total_balance > 0 ? "var(--primary)" : "#10B981";
        const balanceText =
          g.total_balance > 0
            ? `UGX ${g.total_balance.toLocaleString()}`
            : "CLEARED";

        let historyHtml = `
                    <table style="width:100%; margin-top:10px; border-collapse:collapse; font-size:0.85rem;">
                        <thead style="background:var(--surface-hover);">
                            <tr>
                                <th style="padding:6px; text-align:left; border-bottom:1px solid var(--border);">Date & Time</th>
                                <th style="padding:6px; text-align:center; border-bottom:1px solid var(--border);">Type</th>
                                <th style="padding:6px; text-align:right; border-bottom:1px solid var(--border);">Total</th>
                                <th style="padding:6px; text-align:right; border-bottom:1px solid var(--border);">Paid</th>
                                <th style="padding:6px; text-align:right; border-bottom:1px solid var(--border);">Balance</th>
                                <th style="padding:6px; text-align:center; border-bottom:1px solid var(--border); width:32px;"></th>
                            </tr>
                        </thead>
                        <tbody>
                `;
        g.transactions.forEach((t) => {
          const isPayment = t.pos_order_id === 0 || t.total_amount === 0;
          const rowBg = isPayment ? "rgba(16,185,129,0.06)" : "";
          const typeLabel = isPayment
            ? `<span style="font-size:0.72rem; background:#d1fae5; color:#065f46; padding:2px 7px; border-radius:20px; font-weight:700;">PAYMENT</span>`
            : `<span style="font-size:0.72rem; background:#dbeafe; color:#1e40af; padding:2px 7px; border-radius:20px; font-weight:700;">CREDIT</span>`;
          const balDisplay = isPayment
            ? `<span style="color:#10B981; font-weight:700;">-${Math.abs(Number(t.balance)).toLocaleString()}</span>`
            : `<span style="color:#EF4444;">${Number(t.balance).toLocaleString()}</span>`;
          historyHtml += `
                            <tr style="background:${rowBg}">
                                <td style="padding:6px; border-bottom:1px solid var(--border); white-space:nowrap; font-size:0.82rem;">${formatDisplayDate(t.created_at, true)}</td>
                                <td style="padding:6px; text-align:center; border-bottom:1px solid var(--border);">${typeLabel}</td>
                                <td style="padding:6px; text-align:right; border-bottom:1px solid var(--border);">${isPayment ? "-" : Number(t.total_amount).toLocaleString()}</td>
                                <td style="padding:6px; text-align:right; border-bottom:1px solid var(--border); color:#10B981;">${Number(t.amount_paid).toLocaleString()}</td>
                                <td style="padding:6px; text-align:right; border-bottom:1px solid var(--border);">${balDisplay}</td>
                                <td style="padding:6px; text-align:center; border-bottom:1px solid var(--border);">
                                  <button onclick="event.stopPropagation(); deleteSingleCreditRecord(${t.id}, '${g.buyer_name.replace(/'/g, "\\'")}')" 
                                    title="Delete record" 
                                    style="background:transparent; border:none; color:var(--text-muted); cursor:pointer; padding:2px 5px; font-size:0.75rem;">
                                      <i class="fa-solid fa-trash"></i>
                                  </button>
                                </td>
                            </tr>
                    `;
        });
        historyHtml += `</tbody></table>`;

        const item = document.createElement("div");
        item.className = "credit-accordion-item";
        item.innerHTML = `
                    <div class="credit-accordion-header" onclick="this.parentElement.classList.toggle('active')">
                        <div style="font-weight:700; font-size:1.05rem; display:flex; align-items:center; gap:8px;">
                            <i class="fa-solid fa-user-tag" style="color:var(--text-muted); font-size:0.9rem;"></i>
                            ${g.buyer_name}
                        </div>
                        <div style="display:flex; align-items:center; gap:12px;">
                            <div style="color:${balanceColor}; font-weight:700; font-size:1rem;">${balanceText}</div>
                            <button onclick="event.stopPropagation(); deleteCreditAccount('${g.buyer_name.replace(/'/g, "\\'")}')" 
                              title="Delete Credit Account" 
                              style="background:rgba(239, 68, 68, 0.12); color:#ef4444; border:1px solid rgba(239, 68, 68, 0.25); border-radius:6px; padding:5px 10px; cursor:pointer; font-size:0.8rem; font-weight:700; display:inline-flex; align-items:center; gap:5px; transition:all 0.15s ease;">
                                <i class="fa-solid fa-trash-can"></i> Delete
                            </button>
                        </div>
                    </div>
                    <div class="credit-accordion-content">
                        <div class='credit-detail-row'><span><i class="fa-solid fa-mobile-screen"></i> Phone Number:</span> <strong>${g.buyer_phone || "N/A"}</strong></div>
                        <div class='credit-detail-row'><span><i class="fa-solid fa-rotate"></i> Total Transactions:</span> <strong>${g.transactions.length}</strong></div>
                        
                        <div style="margin-top: 15px;">
                            <strong style="font-size:0.9rem;">Transaction History</strong>
                            ${historyHtml}
                        </div>

                        <div style="margin-top: 20px; display:flex; gap:10px; flex-wrap:wrap;">
                            <button class="primary-btn" onclick="openCreditPaymentModal('${g.buyer_name.replace(/'/g, "\\'")}',${g.total_balance})" style="flex:1; min-width:140px; padding: 12px; font-size:0.95rem; background: linear-gradient(135deg,#10B981,#059669);">
                                <i class="fa-solid fa-credit-card"></i> Make a Payment
                            </button>
                            <button class="primary-btn" onclick="printStatement('${g.buyer_name.replace(/'/g, "\\'")}')"
                                style="flex:1; min-width:140px; padding: 12px; font-size:0.95rem;">
                                <i class="fa-solid fa-inbox"></i> Statement
                            </button>
                            <button onclick="deleteCreditAccount('${g.buyer_name.replace(/'/g, "\\'")}')"
                                style="flex:0 0 auto; padding: 12px 18px; font-size:0.95rem; background:rgba(239, 68, 68, 0.12); color:#ef4444; border:1px solid rgba(239, 68, 68, 0.3); border-radius:6px; font-weight:700; cursor:pointer;">
                                <i class="fa-solid fa-trash-can"></i> Delete Account
                            </button>
                        </div>
                    </div>
                `;
        container.appendChild(item);
      });
    } else {
      const errContainer = document.getElementById("credits-list-container");
      if (errContainer)
        errContainer.innerHTML =
          '<div style="text-align:center; padding:30px; color:#EF4444;">Failed to load. Please make sure the server has been restarted.</div>';
    }
  } catch (err) {
    console.error("Failed to load credits:", err);
    const errContainer = document.getElementById("credits-list-container");
    if (errContainer)
      errContainer.innerHTML =
        '<div style="text-align:center; padding:30px; color:#EF4444;">Connection error. Is the server running?</div>';
  }
}

window.deleteCreditAccount = async function (buyerName) {
  if (!buyerName) return;
  const confirmed = confirm(`Are you sure you want to delete the entire credit account for "${buyerName}"? This will permanently delete all associated credit history and records.`);
  if (!confirmed) return;

  try {
    const encodedName = encodeURIComponent(buyerName);
    const res = await fetchAuth(`${API_URL}/credits/account/${encodedName}`, {
      method: "DELETE",
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      showToast(`Credit account for "${buyerName}" deleted.`, "success");
      loadCredits();
    } else {
      alert("Error deleting credit account: " + (data.error || "Failed to delete account."));
    }
  } catch (err) {
    console.error("Failed to delete credit account:", err);
    alert("Network error while deleting credit account.");
  }
};

window.deleteSingleCreditRecord = async function (creditId, buyerName) {
  if (!creditId) return;
  const confirmed = confirm("Are you sure you want to delete this specific credit transaction record?");
  if (!confirmed) return;

  try {
    const res = await fetchAuth(`${API_URL}/credits/${creditId}`, {
      method: "DELETE",
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      showToast("Credit transaction record deleted.", "success");
      loadCredits();
    } else {
      alert("Error deleting record: " + (data.error || "Failed to delete record."));
    }
  } catch (err) {
    console.error("Failed to delete credit record:", err);
    alert("Network error while deleting credit record.");
  }
};

function openCreditPaymentModal(buyerName, totalBalance) {
  document.getElementById("credit-payment-buyer").value = buyerName;
  document.getElementById("credit-payment-amount").value = "";
  document.getElementById("credit-payment-note").value = "";
  document.getElementById("credit-payment-subtitle").textContent =
    `Recording payment for ${buyerName} — Outstanding Balance: UGX ${Number(totalBalance).toLocaleString()}`;
  document.getElementById("credit-payment-modal").classList.remove("hidden");
  setTimeout(
    () => document.getElementById("credit-payment-amount").focus(),
    100,
  );
}

async function submitCreditPayment(e) {
  e.preventDefault();
  const buyerName = document.getElementById("credit-payment-buyer").value;
  const amount = Number(document.getElementById("credit-payment-amount").value);
  const note = document.getElementById("credit-payment-note").value.trim();

  if (!amount || amount <= 0)
    return showToast("Please enter a valid amount.", "warning");

  const btn = e.target.querySelector('[type="submit"]');
  btn.disabled = true;
  btn.textContent = "Recording...";

  try {
    const res = await fetchAuth(`${API_URL}/credits/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buyer_name: buyerName,
        amount_paid: amount,
        note,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      document.getElementById("credit-payment-modal").classList.add("hidden");
      showToast(`${data.message}`, "success");
      loadCredits(); // Refresh the list
      if (typeof loadTransactions === "function") loadTransactions();
      if (typeof loadDashboard === "function") loadDashboard();
    } else {
      showToast(`${data.error}`, "danger");
    }
  } catch (err) {
    console.error(err);
    showToast("Network error. Is the server running?", "danger");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Payment';
  }
}

async function checkAutoStart() {
  try {
    const res = await fetchAuth(`${API_URL}/system/autostart`);
    if (res.ok) {
      const data = await res.json();
      const checkbox = document.getElementById("toggle-autostart");
      if (checkbox) checkbox.checked = data.enabled;
    }
  } catch (e) {
    console.error("Error checking autostart status:", e);
  }
}

async function toggleAutoStart(enable) {
  try {
    const res = await fetchAuth(`${API_URL}/system/autostart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enable }),
    });
    if (res.ok) {
      const data = await res.json();
      showToast(`${data.message}`, "success");
    } else {
      const err = await res.json();
      showToast(`Error toggling auto-start: ${err.error}`, "error");
      const checkbox = document.getElementById("toggle-autostart");
      if (checkbox) checkbox.checked = !enable;
    }
  } catch (e) {
    console.error("Error setting autostart:", e);
    showToast("Network error while configuring auto-start.", "error");
    const checkbox = document.getElementById("toggle-autostart");
    if (checkbox) checkbox.checked = !enable;
  }
}

async function createDesktopShortcut() {
  try {
    const res = await fetchAuth(`${API_URL}/system/create-shortcut`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (res.ok) {
      const data = await res.json();
      showToast(`${data.message}`, "success");
    } else {
      const err = await res.json();
      showToast(`Error creating shortcut: ${err.error}`, "error");
    }
  } catch (e) {
    console.error("Error creating shortcut:", e);
    showToast("Network error while creating shortcut.", "error");
  }
}
window.createDesktopShortcut = createDesktopShortcut;

async function setStaticIP() {
  try {
    const res = await fetchAuth(`${API_URL}/system/set-static-ip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (res.ok) {
      const data = await res.json();
      showToast(`${data.message}`, "success");
    } else {
      const err = await res.json();
      showToast(`Error: ${err.error}`, "error");
    }
  } catch (e) {
    console.error("Error launching static IP script:", e);
    showToast("Network error while launching static IP setup.", "error");
  }
}
window.setStaticIP = setStaticIP;

function printStatement(buyerName) {
  if (!window.creditGroups || !window.creditGroups[buyerName]) {
    alert("Could not find data for this buyer.");
    return;
  }

  const group = window.creditGroups[buyerName];
  const printArea = document.getElementById("statement-print-area");
  if (!printArea) return;

  const bizName = localStorage.getItem("jomish_biz_name") || "JOMISH SUITE";
  const bizContact = localStorage.getItem("jomish_biz_contact") || "";
  const bizLocation =
    localStorage.getItem("jomish_biz_location") || "Kampala, Uganda";
  const bizLogo = localStorage.getItem("jomish_biz_logo") || "";

  let logoHtml = "";
  if (bizLogo) {
    logoHtml = `<div style="text-align:center; margin-bottom: 20px;">
                        <img src="${bizLogo}" style="max-height:80px; max-width:200px;">
                    </div>`;
  }

  let rowsHtml = "";
  group.transactions.forEach((t) => {
    rowsHtml += `
            <tr>
                <td style="padding:10px; border:1px solid #ccc;">${formatDisplayDate(t.created_at, false)}</td>
                <td style="padding:10px; border:1px solid #ccc; text-align:right;">${Number(t.total_amount).toLocaleString()}</td>
                <td style="padding:10px; border:1px solid #ccc; text-align:right;">${Number(t.amount_paid).toLocaleString()}</td>
                <td style="padding:10px; border:1px solid #ccc; text-align:right;">${Number(t.balance).toLocaleString()}</td>
                <td style="padding:10px; border:1px solid #ccc; text-align:right;">${t.promised_date ? formatDisplayDate(t.promised_date, false) : "-"}</td>
            </tr>
        `;
  });

  printArea.innerHTML = `
        ${logoHtml}
        <div style="text-align:center; margin-bottom: 30px;">
            <h1 style="margin:0; font-size:24pt;">${bizName}</h1>
            <p style="margin:5px 0 0 0; font-size:12pt; color:#555;">${bizLocation} ${bizContact ? "| " + bizContact : ""}</p>
            <h2 style="margin:20px 0 0 0; font-size:18pt; text-decoration:underline;">ACCOUNT STATEMENT</h2>
        </div>

        <div style="margin-bottom: 30px; font-size:12pt; display:flex; justify-content:space-between;">
            <div>
                <strong>Customer Name:</strong> ${group.buyer_name}<br>
                <strong>Phone Number:</strong> ${group.buyer_phone || "N/A"}
            </div>
            <div style="text-align:right;">
                <strong>Date Generated:</strong> ${formatDisplayDate(new Date(), false)}<br>
                <strong>Total Balance Owed:</strong> UGX ${group.total_balance.toLocaleString()}
            </div>
        </div>

        <table style="width:100%; border-collapse:collapse; font-size:11pt; margin-bottom:30px;">
            <thead>
                <tr style="background-color:#f8fafc;">
                    <th style="padding:10px; border:1px solid #ccc; text-align:left;">Transaction Date</th>
                    <th style="padding:10px; border:1px solid #ccc; text-align:right;">Order Total (UGX)</th>
                    <th style="padding:10px; border:1px solid #ccc; text-align:right;">Amount Paid (UGX)</th>
                    <th style="padding:10px; border:1px solid #ccc; text-align:right;">Balance (UGX)</th>
                    <th style="padding:10px; border:1px solid #ccc; text-align:right;">Promised Date</th>
                </tr>
            </thead>
            <tbody>
                            ${rowsHtml}
            </tbody>
        </table>

        <div style="margin-top:40px; text-align:center; font-size:10pt; color:#666;">
            <p>Thank you for doing business with us.</p>
            <p style="margin-top:40px; border-top:1px dashed #ccc; padding-top:10px; display:inline-block; width:200px;">Authorized Signature</p>
        </div>
    `;

  clearAllPrintModes();
  document.body.classList.add("print-mode-statement");

  const style = document.createElement("style");
  style.id = "dynamic-print-page-style";
  style.innerHTML = `@page { size: A4 portrait; margin: 15mm; }`;
  document.head.appendChild(style);

  setTimeout(() => {
    window.print();
    document.body.classList.remove("print-mode-statement");
    const s = document.getElementById("dynamic-print-page-style");
    if (s) s.remove();
  }, 500);
}

// â”€â”€ Mobile Hamburger Drawer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function toggleMobileNav() {
  const sidebar = document.getElementById("main-sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  const btn = document.getElementById("hamburger-btn");
  if (!sidebar) return;
  const isOpen = sidebar.classList.toggle("mobile-open");
  btn.classList.toggle("open", isOpen);
  if (isOpen) {
    overlay.classList.add("active");
    document.body.style.overflow = "hidden"; // prevent background scroll
  } else {
    overlay.classList.remove("active");
    document.body.style.overflow = "";
  }
}

function closeMobileNav() {
  const sidebar = document.getElementById("main-sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  const btn = document.getElementById("hamburger-btn");
  if (!sidebar) return;
  sidebar.classList.remove("mobile-open");
  overlay.classList.remove("active");
  if (btn) btn.classList.remove("open");
  document.body.style.overflow = "";
}

// Auto-close drawer when a nav button is tapped on mobile
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".nav-btn[data-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (window.innerWidth <= 768) {
        closeMobileNav();
      }
    });
  });
});

window.toggleMobileNav = toggleMobileNav;
window.closeMobileNav = closeMobileNav;

// ================================================================
// SMART SHIFT TIMETABLE MODULE
// ================================================================

(function () {
  // â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let ttWeekStart = getMondayOfWeek(new Date()); // Monday of current week
  let ttEmployees = []; // full employee list for the override modal
  let ttModal = { date: null, slot: null, startTime: null, endTime: null }; // current modal context

  // â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function getMondayOfWeek(d) {
    const copy = new Date(d);
    const day = copy.getDay(); // 0=Sun â€¦ 6=Sat
    const diff = day === 0 ? -6 : 1 - day; // shift to Monday
    copy.setDate(copy.getDate() + diff);
    copy.setHours(0, 0, 0, 0);
    return copy;
  }

  function dateStr(d) {
    return d.toISOString().split("T")[0];
  }

  function addDays(d, n) {
    const c = new Date(d);
    c.setDate(c.getDate() + n);
    return c;
  }

  function fmtShortDate(d) {
    return d.toLocaleDateString("en-UG", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  function isToday(d) {
    return dateStr(d) === dateStr(new Date());
  }

  // Helper: render slot icon + label
  window.slotHtml = function slotHtml(meta) {
    return `<i class="${meta.icon}" style="color:${meta.color}; margin-right:5px;"></i>${meta.label}`;
  };

  const CAN_OVERRIDE = () => ["CEO", "HR", "Supervisor"].includes(USER_ROLE);
  const CAN_AUTOGEN = () => ["CEO", "HR"].includes(USER_ROLE);

  // â”€â”€ Week Navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.shiftTimetableWeek = function (dir) {
    ttWeekStart = addDays(ttWeekStart, dir * 7);
    loadShiftTimetable();
  };

  window.goToCurrentShiftWeek = function () {
    ttWeekStart = getMondayOfWeek(new Date());
    loadShiftTimetable();
  };

  // â”€â”€ Init (called when Shift Timetable tab activates) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.loadShiftTimetable = async function () {
    injectTimetableButtons();
    await loadAllEmployees();
    await renderTimetable();
  };

  function injectTimetableButtons() {
    const actions = document.getElementById("timetable-actions");
    if (!actions) return;

    // Remove previously injected buttons (avoid duplicates on tab re-enter)
    ["tt-btn-autogen", "tt-btn-clear"].forEach((id) => {
      const old = document.getElementById(id);
      if (old) old.remove();
    });

    if (CAN_AUTOGEN()) {
      const autoBtn = document.createElement("button");
      autoBtn.id = "tt-btn-autogen";
      autoBtn.className = "primary-btn";
      autoBtn.innerHTML =
        '<i class="fa-solid fa-wand-magic-sparkles"></i> Auto-Schedule Week';
      autoBtn.onclick = smartAutoSchedule;
      actions.prepend(autoBtn);

      const clearBtn = document.createElement("button");
      clearBtn.id = "tt-btn-clear";
      clearBtn.className = "secondary-btn";
      clearBtn.style.color = "var(--danger)";
      clearBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Clear Week';
      clearBtn.onclick = clearShiftWeek;
      actions.prepend(clearBtn);
    }
  }

  async function loadAllEmployees() {
    try {
      const res = await fetchAuth(`${API_URL}/employees`);
      const data = await res.json();
      ttEmployees = (data.employees || []).filter((e) => e.is_active);
    } catch (e) {
      console.error("[Timetable] loadAllEmployees error:", e);
    }
  }

  // â”€â”€ Render the full weekly grid â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function renderTimetable() {
    const weekEnd = addDays(ttWeekStart, 6);
    const from = dateStr(ttWeekStart);
    const to = dateStr(weekEnd);

    // Update week label
    const lbl = document.getElementById("tt-week-label");
    if (lbl) {
      lbl.textContent = `${from}  →  ${to}`;
    }

    // Fetch assignments for the week
    let assignments = [];
    try {
      const res = await fetchAuth(
        `${API_URL}/shift-assignments?from=${from}&to=${to}`,
      );
      const data = await res.json();
      assignments = data.assignments || [];
    } catch (e) {
      console.error("[Timetable] fetch error:", e);
    }

    // Build day columns (Mon–Sun)
    const days = Array.from({ length: 7 }, (_, i) => addDays(ttWeekStart, i));

    // Build header
    const headerRow = document.getElementById("tt-header-row");
    if (headerRow) {
      headerRow.innerHTML = `<th style="padding:12px 16px; text-align:left; font-size:0.72rem; color:#94A3B8; text-transform:uppercase; border-bottom:2px solid var(--border); min-width:110px;">Slot</th>`;
      days.forEach((d) => {
        const todayStyle = isToday(d)
          ? "background:rgba(99,102,241,0.08); color:var(--primary);"
          : "";
        headerRow.innerHTML += `
                    <th style="padding:10px 8px; text-align:center; font-size:0.78rem; border-bottom:2px solid var(--border); min-width:120px; ${todayStyle}">
                        ${fmtShortDate(d)}
                    </th>`;
      });
    }

    // Index assignments: slot → date → [items]
    const idx = {};
    assignments.forEach((a) => {
      const key = `${a.slot}|${a.shift_date}`;
      if (!idx[key]) idx[key] = [];
      idx[key].push(a);
    });

    // Render slot rows
    const tbody = document.getElementById("tt-body");
    if (!tbody) return;
    tbody.innerHTML = "";

    let totalSlots = 0,
      filledSlots = 0;

    GLOBAL_SHIFTS.forEach((shift) => {
      const slot = shift.id;
      const meta = shift;
      const row = document.createElement("tr");

      // Slot label cell — shows time derived from configuration
      const timeRange = `${shift.start_time} - ${shift.end_time}`;

      row.innerHTML = `
                <td style="padding:12px 14px; border-bottom:1px solid var(--border); border-right:2px solid var(--border); background:var(--surface); vertical-align:top;">
                    <div style="font-weight:700; font-size:0.88rem; display:flex; align-items:center;">${slotHtml(meta)}</div>
                    <div style="font-size:0.72rem; color:#94A3B8; margin-top:2px;">${timeRange}</div>
                </td>`;

      days.forEach((d) => {
        const ds = dateStr(d);
        const key = `${slot}|${ds}`;
        const list = idx[key] || [];
        const todayStyle = isToday(d)
          ? "background:rgba(99,102,241,0.04);"
          : "";

        totalSlots++;
        if (list.length > 0) filledSlots++;

        const chips = list
          .map((a) => {
            const roleColor = stringToColor(a.role);
            return `
                        <div style="display:flex; align-items:center; gap:6px; background:${roleColor}22; border:1px solid ${roleColor}44; border-radius:20px; padding:4px 10px; font-size:0.75rem; margin-bottom:4px; cursor:default;" title="${a.role}">
                            <span style="width:7px; height:7px; border-radius:50%; background:${roleColor}; flex-shrink:0;"></span>
                            <span style="font-weight:600; color:var(--text);">${a.first_name} ${a.last_name}</span>
                            ${CAN_OVERRIDE() ? `<span onclick="removeShiftAssignment(${a.id})" style="cursor:pointer; color:#94A3B8; margin-left:4px; font-size:0.9rem;" title="Remove">&times;</span>` : ""}
                        </div>`;
          })
          .join("");

        const addBtn = CAN_OVERRIDE()
          ? `<button onclick="openShiftModal('${ds}','${slot}','${shift.start_time}','${shift.end_time}')"
                         style="font-size:0.7rem; color:var(--primary); background:none; border:1px dashed var(--primary); border-radius:16px; padding:3px 10px; cursor:pointer; margin-top:4px; opacity:0.7; transition:opacity .15s;"
                         onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.7">+ Add</button>`
          : "";

        row.innerHTML += `
                    <td style="padding:10px 8px; border-bottom:1px solid var(--border); border-right:1px solid var(--border); vertical-align:top; ${todayStyle}">
                        ${chips}
                        ${addBtn}
                    </td>`;
      });

      tbody.appendChild(row);
    });

    // Update stats
    const uniqueDeployed = new Set(assignments.map((a) => a.employee_id)).size;
    const el = (id) => document.getElementById(id);
    if (el("count-active-shifts"))
      el("count-active-shifts").textContent = `${assignments.length} Shifts`;
    if (el("count-deployed")) el("count-deployed").textContent = uniqueDeployed;
    if (el("count-gaps"))
      el("count-gaps").textContent = totalSlots - filledSlots;
    if (el("count-coverage")) {
      const pct =
        totalSlots > 0 ? Math.round((filledSlots / totalSlots) * 100) : 0;
      el("count-coverage").textContent = `${pct}%`;
      el("count-coverage").style.color =
        pct >= 80 ? "#10B981" : pct >= 50 ? "#F59E0B" : "#EF4444";
    }

    renderFairnessBars(assignments);
  }

  // â”€â”€ Fairness Bars â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function renderFairnessBars(assignments) {
    const container = document.getElementById("tt-fairness-bars");
    if (!container) return;

    const countMap = {};
    assignments.forEach((a) => {
      const key = `${a.employee_id}|${a.first_name} ${a.last_name}|${a.role}`;
      countMap[key] = (countMap[key] || 0) + 1;
    });

    if (Object.keys(countMap).length === 0) {
      container.innerHTML =
        '<p style="color:var(--text-muted); font-size:0.85rem;">No assignments this week yet.</p>';
      return;
    }

    const maxCount = Math.max(...Object.values(countMap));
    const sorted = Object.entries(countMap).sort((a, b) => b[1] - a[1]);

    container.innerHTML = sorted
      .map(([key, count]) => {
        const [, name, role] = key.split("|");
        const pct = Math.round((count / maxCount) * 100);
        const rc = stringToColor(role);
        const bars =
          "█".repeat(count) + "░".repeat(Math.max(0, maxCount - count));
        return `
                <div style="display:flex; align-items:center; gap:12px;">
                    <div style="width:160px; font-size:0.8rem; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${name} (${role})">${name}</div>
                    <div style="flex:1; background:var(--background); border-radius:8px; overflow:hidden; height:10px;">
                        <div style="width:${pct}%; background:${rc}; height:100%; border-radius:8px; transition:width .4s;"></div>
                    </div>
                    <div style="font-size:0.78rem; color:#94A3B8; min-width:60px; text-align:right;">${count} shift${count !== 1 ? "s" : ""}</div>
                    <div style="font-size:0.7rem; color:${rc}; min-width:52px;">${role}</div>
                </div>`;
      })
      .join("");
  }

  // â”€â”€ Color from string (deterministic) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function stringToColor(str) {
    const palette = [
      "#6366F1",
      "#10B981",
      "#F59E0B",
      "#EC4899",
      "#0EA5E9",
      "#8B5CF6",
      "#EF4444",
      "#14B8A6",
    ];
    let hash = 0;
    for (let i = 0; i < (str || "").length; i++)
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return palette[Math.abs(hash) % palette.length];
  }

  // â”€â”€ Override Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.openShiftModal = async function (date, slot, startTime, endTime) {
    ttModal = { date, slot, startTime, endTime };

    const infoEl = document.getElementById("shift-modal-info");
    if (infoEl) {
      const meta = GLOBAL_SHIFTS.find((s) => s.id === slot) || {
        label: slot,
        icon: "fa-solid fa-clock",
        color: "#94A3B8",
      };
      infoEl.innerHTML = `
                <strong>${slotHtml(meta)}</strong> &nbsp;on&nbsp; <strong>${date}</strong><br>
                <span style="font-size:0.8rem; color:#94A3B8;">${startTime} – ${endTime}</span>`;
    }

    // Always re-fetch employees so the list is guaranteed fresh
    const sel = document.getElementById("shift-modal-employee");
    if (sel) {
      // Pre-populate from cache immediately to avoid blank dropdown
      if (window.EMPLOYEES_CACHE && window.EMPLOYEES_CACHE.length > 0) {
        sel.innerHTML = '<option value="">-- Select Employee --</option>';
        window.EMPLOYEES_CACHE.forEach((e) => {
          const opt = document.createElement("option");
          opt.value = e.id;
          const optName =
            `${e.first_name || ""} ${e.last_name || ""}`.trim() ||
            e.username ||
            e.email ||
            `Staff ${e.id}`;
          opt.textContent = `${optName} (${e.role || "Employee"})`;
          sel.appendChild(opt);
        });
      } else {
        sel.innerHTML =
          '<option value="" disabled selected>Loading employees...</option>';
      }
    }
    try {
      const empRes = await fetchAuth(`${API_URL}/employees`);
      const empData = await empRes.json();
      ttEmployees = empData.employees || [];
      // Update global cache if fresh data arrived
      if (ttEmployees.length > 0) window.EMPLOYEES_CACHE = ttEmployees;
    } catch (e) {
      console.error("[ShiftModal] employee fetch error:", e);
      ttEmployees = [];
    }

    // Fall back to cached employee list if fetch returned nothing
    if (
      ttEmployees.length === 0 &&
      window.EMPLOYEES_CACHE &&
      window.EMPLOYEES_CACHE.length > 0
    ) {
      ttEmployees = window.EMPLOYEES_CACHE;
    }

    // Populate dropdown
    if (sel) {
      sel.innerHTML = '<option value="">-- Select Employee --</option>';
      if (ttEmployees.length === 0) {
        sel.innerHTML +=
          "<option disabled>No active employees found — ensure employees are added in HR tab</option>";
      } else {
        ttEmployees.forEach((e) => {
          const opt = document.createElement("option");
          opt.value = e.id;
          const optName =
            `${e.first_name || ""} ${e.last_name || ""}`.trim() ||
            e.username ||
            e.email ||
            `Staff ${e.id}`;
          opt.textContent = `${optName} (${e.role || "Employee"})`;
          sel.appendChild(opt);
        });
      }
    }

    // Show existing assignees for this cell
    fetchCurrentAssignees(date, slot);

    document.getElementById("shift-override-modal").classList.remove("hidden");
  };

  async function fetchCurrentAssignees(date, slot) {
    const chipsDiv = document.getElementById("shift-modal-chips");
    const listDiv = document.getElementById("shift-modal-existing-list");
    if (!chipsDiv || !listDiv) return;

    try {
      const res = await fetchAuth(
        `${API_URL}/shift-assignments?from=${date}&to=${date}`,
      );
      const data = await res.json();
      const mine = (data.assignments || []).filter((a) => a.slot === slot);

      if (mine.length > 0) {
        listDiv.style.display = "block";
        chipsDiv.innerHTML = mine
          .map(
            (a) => `
                    <div style="display:flex; align-items:center; gap:6px; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); border-radius:20px; padding:5px 12px; font-size:0.78rem; cursor:pointer;"
                         onclick="removeShiftAssignment(${a.id})">
                        ${a.first_name} ${a.last_name}
                        <span style="color:#EF4444; font-weight:bold;">âœ•</span>
                    </div>`,
          )
          .join("");
      } else {
        listDiv.style.display = "none";
      }
    } catch (e) {
      console.error(e);
    }
  }

  window.closeShiftModal = function () {
    document.getElementById("shift-override-modal").classList.add("hidden");
  };

  window.saveShiftOverride = async function () {
    const empId = document.getElementById("shift-modal-employee").value;
    if (!empId) {
      showToast("Please select an employee.", "warning");
      return;
    }

    try {
      const res = await fetchAuth(`${API_URL}/shift-assignments`, {
        method: "POST",
        body: JSON.stringify({
          employee_id: empId,
          shift_date: ttModal.date,
          slot: ttModal.slot,
          start_time: ttModal.startTime,
          end_time: ttModal.endTime,
        }),
      });
      if (res.ok) {
        showToast("Shift assigned successfully.", "success");
        closeShiftModal();
        renderTimetable();
      } else {
        const d = await res.json();
        showToast(d.error || "Failed to assign shift.", "danger");
      }
    } catch (e) {
      showToast("Network error.", "danger");
    }
  };

  window.removeShiftAssignment = async function (id) {
    if (!confirm("Remove this shift assignment?")) return;
    try {
      const res = await fetchAuth(`${API_URL}/shift-assignments/${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        showToast("Assignment removed.", "success");
        closeShiftModal();
        renderTimetable();
      } else {
        const d = await res.json();
        showToast(d.error || "Failed to remove.", "danger");
      }
    } catch (e) {
      showToast("Network error.", "danger");
    }
  };

  // â”€â”€ Smart Auto-Schedule â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.smartAutoSchedule = async function () {
    const from = dateStr(ttWeekStart);
    if (
      !confirm(
        `Auto-schedule the week of ${from}?\nThis will replace any existing assignments for this week.`,
      )
    )
      return;

    const btn = document.getElementById("tt-btn-autogen");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
    }

    try {
      const res = await fetchAuth(`${API_URL}/scheduler/smart-generate`, {
        method: "POST",
        body: JSON.stringify({ week_start: from, clear_existing: true }),
      });
      const data = await res.json();
      if (res.ok) {
        let msg = data.message || "Done.";
        if (data.gaps && data.gaps.length > 0) {
          msg += `\n\nWARNING: ${data.gaps.length} staffing gap(s) detected (not enough employees for some roles/slots).`;
        }
        showToast(data.message, "success");
        if (data.gaps?.length) alert(msg);
        renderTimetable();
      } else {
        showToast(data.error || "Auto-schedule failed.", "danger");
      }
    } catch (e) {
      showToast("Network error during auto-schedule.", "danger");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML =
          '<i class="fa-solid fa-wand-magic-sparkles"></i> Auto-Schedule Week';
      }
    }
  };

  // â”€â”€ Clear Week â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.clearShiftWeek = async function () {
    const from = dateStr(ttWeekStart);
    if (!confirm(`Clear ALL shift assignments for the week of ${from}?`))
      return;
    try {
      const res = await fetchAuth(`${API_URL}/shift-assignments/week/${from}`, {
        method: "DELETE",
      });
      const d = await res.json();
      showToast(d.message || "Week cleared.", "success");
      renderTimetable();
    } catch (e) {
      showToast("Network error.", "danger");
    }
  };

  // â”€â”€ Live Sync — refresh timetable when DB updates arrive â”€â”€â”€â”€â”€â”€â”€
  function initShiftSync() {
    if (window._socket) {
      window._socket.on("db_updated", (data) => {
        if (data.module === "shift_assignments") {
          const timetableSection = document.getElementById("schedules");
          if (
            timetableSection &&
            timetableSection.classList.contains("active")
          ) {
            renderTimetable();
          }
        }
      });
    }
  }

  // â”€â”€ Hook into nav: load timetable when tab is clicked â”€â”€â”€â”€â”€â”€â”€â”€â”€
  document.addEventListener("DOMContentLoaded", () => {
    // Intercept nav button for 'schedules' tab
    document
      .querySelectorAll('.nav-btn[data-target="schedules"]')
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          ttWeekStart = getMondayOfWeek(new Date());
          loadShiftTimetable();
        });
      });
    // Init live-sync after socket connects
    setTimeout(initShiftSync, 2000);
  });

  // Expose for dashboard timetable (loads today's from shift_assignments)
  window.loadDayTimetable = async function () {
    const today = dateStr(new Date());
    const tbody = document.querySelector("#dash-timetable tbody");
    if (!tbody) return;

    try {
      const res = await fetchAuth(
        `${API_URL}/shift-assignments?from=${today}&to=${today}`,
      );
      const data = await res.json();
      const rows = data.assignments || [];

      tbody.innerHTML = "";
      if (rows.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="3" style="text-align:center;padding:20px;color:#94A3B8;">No shifts scheduled today.</td></tr>';
        return;
      }
      rows.forEach((r) => {
        const meta = GLOBAL_SHIFTS.find((s) => s.id === r.slot) || {
          label: r.slot,
          icon: "fa-solid fa-clock",
          color: "#94A3B8",
        };
        const now = new Date();
        const [sh, sm] = r.start_time.split(":").map(Number);
        const [eh, em] = r.end_time.split(":").map(Number);
        const startM = sh * 60 + sm,
          endM = eh * 60 + em,
          nowM = now.getHours() * 60 + now.getMinutes();
        const isActive = nowM >= startM && nowM < endM;
        const badge = isActive
          ? '<span style="background:#10B981;color:#fff;font-size:0.65rem;padding:2px 7px;border-radius:12px;margin-left:6px;">ON DUTY</span>'
          : "";
        const tr = document.createElement("tr");
        tr.innerHTML = `
                    <td>${r.first_name} ${r.last_name}${badge}</td>
                    <td><span style="font-size:0.8rem;color:#94A3B8;">${r.role}</span></td>
                    <td style="font-size:0.82rem;">${slotHtml(meta)}<br><span style="color:#94A3B8;">${r.start_time}–${r.end_time}</span></td>`;
        tbody.appendChild(tr);
      });
    } catch (e) {
      console.error("[DayTimetable]", e);
    }
  };
})();

// ==== COD Modal Logic (Moved to Tab) ====
window.openCodModal = function () {
  switchPOSView("pending");
};

window.closeCodModal = function () {
  switchPOSView("register");
};

window.removePendingOrderFromUI = function (posOrderId, txId) {
  const pId = posOrderId ? Number(posOrderId) : null;
  const tId = txId ? Number(txId) : null;

  // 1. Instantly remove card(s) from the Pending tab
  const listContainer = document.getElementById("cod-list-container");
  if (listContainer) {
    const cards = listContainer.querySelectorAll("[data-pos-order-id], [id^='pending-order-card-']");
    cards.forEach((card) => {
      const cardPId = Number(card.getAttribute("data-pos-order-id"));
      const cardTId = Number(card.getAttribute("data-tx-id"));
      if ((pId && cardPId === pId) || (tId && cardTId === tId)) {
        card.remove();
      }
    });

    const remainingCards = listContainer.querySelectorAll("[data-pos-order-id], [id^='pending-order-card-']");
    const badge = document.getElementById("cod-badge-count");
    if (badge) {
      if (remainingCards.length > 0) {
        badge.style.display = "inline-block";
        badge.textContent = remainingCards.length;
      } else {
        badge.style.display = "none";
      }
    }
    if (remainingCards.length === 0) {
      listContainer.innerHTML =
        '<p style="text-align:center;color:var(--text-muted);padding:20px;">No pending sales / transactions.</p>';
    }
  }

  // 2. Instantly remove row(s) from Customer Invoices table if present
  const custInvoicesTbody = document.getElementById("customer-invoices-tbody");
  if (custInvoicesTbody) {
    const rows = custInvoicesTbody.querySelectorAll("tr");
    rows.forEach((r) => {
      const rowPId = Number(r.getAttribute("data-pos-order-id"));
      const rowTId = Number(r.getAttribute("data-tx-id"));
      if ((pId && rowPId === pId) || (tId && rowTId === tId)) {
        r.remove();
      }
    });
    if (typeof _allCustomerInvoices !== "undefined" && Array.isArray(_allCustomerInvoices)) {
      _allCustomerInvoices = _allCustomerInvoices.filter((inv) => {
        if (pId && Number(inv.pos_order_id) === pId) return false;
        if (tId && Number(inv.transaction_id) === tId) return false;
        return true;
      });
      const invBadge = document.getElementById("sme-invoice-badge");
      if (invBadge) {
        if (_allCustomerInvoices.length > 0) {
          invBadge.style.display = "inline-block";
          invBadge.textContent = _allCustomerInvoices.length;
        } else {
          invBadge.style.display = "none";
        }
      }
      if (_allCustomerInvoices.length === 0) {
        custInvoicesTbody.innerHTML =
          '<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--text-muted);">No unpaid customer invoices found.</td></tr>';
      }
    }
  }

  // 3. If cashier currently has this order open in payment panel or edit mode:
  if (window._pendingOrderId && pId && Number(window._pendingOrderId) === pId) {
    if (typeof closePaymentPanel === "function") closePaymentPanel();
    posCart = [];
    if (typeof renderCart === "function") renderCart();
    if (typeof showToast === "function") {
      showToast("Notice: The pending order you were collecting was deleted by an admin.", "warning");
    }
  }
  if (typeof _currentEditOrder !== "undefined" && _currentEditOrder && pId && Number(_currentEditOrder.id) === pId) {
    if (typeof cancelEditOrder === "function") cancelEditOrder();
    if (typeof showToast === "function") {
      showToast("Notice: The pending order you were editing was deleted by an admin.", "warning");
    }
  }
};

let _allPendingOrders = [];

window.filterPendingOrders = function (query) {
  const q = (query || "").trim();
  const filtered = _filterPendingOrdersList(_allPendingOrders, q);
  _renderPendingOrders(filtered, q);
};

function _filterPendingOrdersList(list, query) {
  if (!query || !query.trim()) return list;
  const q = query.trim().toLowerCase();
  const digitsOnly = q.replace(/\D/g, "");

  return list.filter((d) => {
    // 1. Invoice number match: e.g. "003", "3", "ivn003", "inv003"
    const invNum = d.invoice_number || d.pos_order_id;
    const invLabel = formatDocNo("INV", invNum).toLowerCase();
    const rawInv = String(invNum).toLowerCase();
    const padded = String(invNum).padStart(3, "0");
    const invoiceMatch =
      invLabel.includes(q) ||
      rawInv.includes(q) ||
      (digitsOnly.length > 0 && (padded.includes(digitsOnly) || rawInv.includes(digitsOnly)));

    // 2. Server name match
    const serverMatch = (d.served_by || "").toLowerCase().includes(q);

    // 3. Client name match
    const clientMatch =
      (d.client_name || "").toLowerCase().includes(q) ||
      (d.buyer_name || "").toLowerCase().includes(q);

    // 4. Specific product match: brings all orders with the product
    const productMatch =
      Array.isArray(d.items) &&
      d.items.some((it) => (it.name || it.product_name || "").toLowerCase().includes(q));

    return invoiceMatch || serverMatch || clientMatch || productMatch;
  });
}

function _renderPendingOrders(deliveries, currentQuery = "") {
  const listContainer = document.getElementById("cod-list-container");
  if (!listContainer) return;
  const _role = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
  const isCashierRole = _role === "CASHIER";

  if (deliveries.length === 0) {
    if (currentQuery) {
      listContainer.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:30px;"><i class="fa-solid fa-magnifying-glass"></i> No pending orders match "${currentQuery}".</p>`;
    } else {
      listContainer.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">No pending sales / transactions.</p>';
    }
    return;
  }

  let html = "";
  deliveries.forEach((d) => {
    const safeClient = (d.client_name || "").replace(/'/g, "\\'");
    const safeServer = (d.served_by || "").replace(/'/g, "\\'");
    const invNum = d.invoice_number || d.pos_order_id;
    const invoiceLabel = formatDocNo("INV", invNum);

    const waiterBadge = d.served_by
      ? `<div style="display:inline-flex; align-items:center; gap:5px; background:rgba(79, 70, 229, 0.12); color:var(--primary, #4F46E5); padding:3px 9px; border-radius:12px; font-size:0.83rem; font-weight:700; margin-top:4px;">
           <i class="fa-solid fa-bell-concierge"></i> Served by: ${d.served_by}
         </div>`
      : "";
    html += `
      <div id="pending-order-card-${d.pos_order_id}" data-pos-order-id="${d.pos_order_id}" data-tx-id="${d.transaction_id || ''}" style="background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:15px; margin-bottom:12px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div style="flex:1;">
            <h4 style="margin:0 0 3px 0; color:var(--text); font-size:1rem;">${invoiceLabel}</h4>
            <p style="margin:0 0 2px 0; font-size:0.88rem; color:var(--text-muted);"><i class="fa-solid fa-user"></i> ${d.client_name}</p>
            <p style="margin:0 0 2px 0; font-size:0.85rem; color:var(--text-muted);"><i class="fa-solid fa-location-dot"></i> ${d.client_location || 'In-Store'}</p>
            ${waiterBadge}
            <p style="margin:6px 0 0 0; font-weight:700; color:var(--primary); font-size:1rem;">Total: UGX ${Number(d.total_amount).toLocaleString()}</p>
          </div>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <button onclick="openEditPendingOrder(${d.pos_order_id})"
              style="background:var(--surface); color:var(--text); border:1px solid var(--border); padding:10px 14px; border-radius:6px; cursor:pointer; font-weight:600; white-space:nowrap;">
              <i class="fa-solid fa-pen-to-square"></i> Edit Order
            </button>
            ${isCashierRole ? `<button onclick="openPendingOrderCheckout(${d.pos_order_id}, ${d.total_amount}, '${safeClient}', '${safeServer}')"
              style="background:var(--primary); color:white; border:none; padding:10px 18px; border-radius:6px; cursor:pointer; font-weight:600; white-space:nowrap;">
              <i class="fa-solid fa-cash-register"></i> Collect Payment
            </button>` : ''}
          </div>
        </div>
        <div id="items-${d.pos_order_id}" style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border); font-size:0.83rem; color:var(--text-muted);">
          ${
            Array.isArray(d.items) && d.items.length > 0
              ? d.items.map(i =>
                  `<div style="display:flex; justify-content:space-between; padding:3px 0;">
                    <span>${i.name || i.product_name || 'Item'} &times; ${i.qty}</span>
                    <span style="color:var(--text); font-weight:600;">UGX ${Number(i.total || i.price * i.qty).toLocaleString()}</span>
                  </div>`
                ).join("")
              : d.items === null || d.items === undefined
                ? '<span style="color:var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Loading item details...</span>'
                : '<span style="color:var(--text-muted); font-style:italic;">No items recorded for this order.</span>'
          }
        </div>
      </div>
    `;
  });
  listContainer.innerHTML = html;

  // Fallback: If items weren't pre-loaded (null/undefined), fetch them asynchronously
  deliveries.forEach(async (d) => {
    // If items were pre-loaded (even as empty array), skip fetch
    if (Array.isArray(d.items)) return;
    const el = document.getElementById(`items-${d.pos_order_id}`);
    if (!el) return;
    // Show spinner
    el.innerHTML = '<span style="color:var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Loading item details...</span>';
    try {
      const ir = await fetchAuth(`${API_URL}/pos_orders/${d.pos_order_id}/items`);
      if (ir.ok) {
        const items = await ir.json();
        d.items = items || [];
        if (items && items.length > 0) {
          el.innerHTML = items.map(i =>
            `<div style="display:flex; justify-content:space-between; padding:3px 0;">
              <span>${i.name || i.product_name || 'Item'} &times; ${i.qty}</span>
              <span style="color:var(--text); font-weight:600;">UGX ${Number(i.total || i.price * i.qty).toLocaleString()}</span>
            </div>`
          ).join("");
        } else {
          el.innerHTML = '<span style="color:var(--text-muted); font-style:italic;">No items recorded for this order.</span>';
        }
      } else {
        el.innerHTML = `<span style="color:var(--text-muted); font-style:italic;">Could not load items.</span>`;
      }
    } catch (_) {
      if (el) el.innerHTML = '<span style="color:var(--text-muted); font-style:italic;">Could not load items.</span>';
    }
  });
}

window.loadPendingCOD = async function (force = true) {
  const listContainer = document.getElementById("cod-list-container");
  if (listContainer && (!listContainer.children.length || listContainer.innerText.includes("Loading"))) {
    listContainer.innerHTML =
      '<p style="text-align:center;color:var(--text-muted);padding:30px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading pending orders...</p>';
  }
  try {
    // Always force fresh fetch from server with cache-busting timestamp to avoid any stale/phantom orders
    const fetchUrl = `${API_URL}/deliveries/pending-cod?force_refresh=1&_t=${Date.now()}`;
    const res = await fetchAuth(fetchUrl);
    if (res.ok) {
      const deliveries = await res.json();
      const badge = document.getElementById("cod-badge-count");

      if (badge) {
        if (deliveries.length > 0) {
          badge.style.display = "inline-block";
          badge.textContent = deliveries.length;
        } else {
          badge.style.display = "none";
        }
      }

      _allPendingOrders = deliveries;
      const searchVal = document.getElementById("pending-orders-search")?.value || "";
      const toShow = _filterPendingOrdersList(_allPendingOrders, searchVal);
      _renderPendingOrders(toShow, searchVal);
    } else {
      const err = await res.json().catch(() => ({}));
      if (listContainer) {
        listContainer.innerHTML = `<p style="text-align:center;color:var(--danger);padding:20px;"><i class="fa-solid fa-triangle-exclamation"></i> Error loading pending orders: ${err.error || res.statusText || 'Server error'}</p>`;
      }
    }
  } catch (e) {
    console.error("Failed to load pending COD:", e);
    if (listContainer) {
      listContainer.innerHTML = '<p style="text-align:center;color:var(--danger);padding:20px;"><i class="fa-solid fa-triangle-exclamation"></i> Could not connect to server to load pending orders.</p>';
    }
  }
};

// Cancel / Void a pending order directly from the Pending tab
window.cancelPendingOrder = async function (posOrderId, txId) {
  if (!confirm("Are you sure you want to cancel and void this pending order? This action cannot be undone.")) return;
  try {
    showToast("Cancelling order...", "info");
    const targetId = txId || posOrderId;
    const res = await fetchAuth(`${API_URL}/transactions/${targetId}`, { method: "DELETE" });
    if (res.ok) {
      showToast("Order cancelled successfully.", "success");
      const card = document.getElementById(`pending-order-card-${posOrderId}`);
      if (card) card.remove();
      loadPendingCOD(true);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast("Failed to cancel order: " + (err.error || "Server error"), "danger");
    }
  } catch (e) {
    showToast("Error cancelling order: " + e.message, "danger");
  }
};

// Print kitchen token for a pending order
window.printPendingOrderToken = async function (posOrderId) {
  try {
    showToast("Printing kitchen token...", "info");
    const [orderRes, itemsRes] = await Promise.all([
      fetchAuth(`${API_URL}/pos_orders/${posOrderId}`),
      fetchAuth(`${API_URL}/pos_orders/${posOrderId}/items`),
    ]);
    if (!orderRes.ok) throw new Error("Order not found");
    const order = await orderRes.json();
    const items = itemsRes.ok ? await itemsRes.json() : [];
    const invLabel = formatDocNo("INV", order.invoice_number || order.id);
    const dateStr = new Date().toLocaleString("en-UG", { timeZone: "Africa/Kampala" });
    const tokenData = {
      isInvoice: false,
      printTokenOnly: true,
      orderId: invLabel,
      dateStr,
      cashierName: USER_NAME || "Staff",
      servedBy: order.served_by || USER_NAME || "Staff",
      items: items.map((i) => ({ name: i.name, qty: i.qty || 1, price: i.price })),
    };
    _printHTMLQueue([_buildKitchenTokenHTML(tokenData)]);
    showToast(`Token for ${invLabel} printed!`, "success");
  } catch (e) {
    console.error("Print token error:", e);
    showToast("Error printing token: " + e.message, "error");
  }
};

// Print invoice for a pending order (cashier view)
window.printPendingInvoice = async function (posOrderId, totalAmount, clientName, servedBy, invoiceNumber) {
  try {
    _printedReceiptNos.add(Number(posOrderId));
    const btn = document.getElementById(`btn-print-pending-${posOrderId}`);
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = "0.4";
      btn.style.pointerEvents = "none";
      btn.style.background = "#94a3b8";
      btn.innerHTML = '<i class="fa-solid fa-check"></i> Printed';
    }

    const itemsRes = await fetchAuth(`${API_URL}/pos_orders/${posOrderId}/items`);
    let items = [];
    if (itemsRes.ok) {
      items = await itemsRes.json();
    }
    if (!items || items.length === 0) {
      items = [{ name: "Invoice Payment", qty: 1, price: totalAmount }];
    }
    // Fetch a transaction_id / invoice_number if available
    let invNum = invoiceNumber || null;
    let orderServer = servedBy || null;
    try {
      const txRes = await fetchAuth(`${API_URL}/pos_orders/${posOrderId}`);
      if (txRes.ok) {
        const txData = await txRes.json();
        if (!invNum) invNum = txData.invoice_number || txData.id || null;
        if (!orderServer && txData.served_by) orderServer = txData.served_by;
      }
    } catch (_) {}
    printReceipt(
      items,
      totalAmount,
      invNum || posOrderId,
      "PENDING",
      totalAmount,
      clientName || "",
      null,
      true,
      orderServer
    );
  } catch (e) {
    console.error("Failed to print pending invoice:", e);
    showToast("Could not load invoice details.", "error");
  }
};

// ========================================================
// STOCK MOVEMENTS MODAL
// ========================================================
let _smProductId = null;
let _smProductName = "";
let _smCurrentStock = 0;
let _smThreshold = 10;

async function openStockMovements(productId, productName, currentStock, threshold) {
  const modal = document.getElementById("stock-movements-modal");
  if (!modal) return;
  modal.classList.remove("hidden");

  _smProductId = productId;
  _smProductName = productName || "Product";
  _smCurrentStock = Number(currentStock) || 0;
  _smThreshold = threshold !== undefined && threshold !== null ? threshold : 10;

  renderStockMovementsHeader();
  await _loadStockMovements();
}
window.openStockMovements = openStockMovements;

function renderStockMovementsHeader() {
  const infoEl = document.getElementById("stock-movement-product-info");
  if (!infoEl) return;
  infoEl.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
      <div>
        <strong style="font-size:1.05rem; color:var(--text);">${_smProductName}</strong>
        <span style="display:inline-block; margin-left:8px; padding:2px 8px; border-radius:6px; font-weight:700; background:rgba(99,102,241,0.12); color:var(--primary); font-size:0.85rem;">
          Current Stock: <span id="sm-badge-stock">${_smCurrentStock}</span>
        </span>
        <span style="display:inline-block; margin-left:4px; padding:2px 8px; border-radius:6px; font-weight:600; background:rgba(245,158,11,0.12); color:#f59e0b; font-size:0.85rem;">
          Low Stock Alert &lt; ${_smThreshold}
        </span>
      </div>
      <button type="button" onclick="_loadStockMovements()" class="btn-secondary" style="padding:4px 10px; font-size:0.8rem; border-radius:6px; display:inline-flex; align-items:center; gap:5px;">
        <i class="fa-solid fa-arrows-rotate"></i> Refresh
      </button>
    </div>
    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:10px 12px; background:var(--surface); border:1px solid var(--border); border-radius:8px;">
      <span style="font-size:0.82rem; font-weight:700; color:var(--text-muted); white-space:nowrap;">
        <i class="fa-solid fa-sliders"></i> Manual Adjust:
      </span>
      <input type="number" id="sm-adj-qty" placeholder="Qty (+5 or -3)" style="width:115px; padding:6px 10px; border:1px solid var(--border); border-radius:6px; background:var(--background); color:var(--text); font-size:0.85rem;" oninput="this.style.color=this.value<0?'#EF4444':(this.value>0?'#10B981':'inherit')">
      <input type="text" id="sm-adj-note" placeholder="Reason (e.g. Damaged, Expired, Inventory audit, Return)" style="flex:1; min-width:160px; padding:6px 10px; border:1px solid var(--border); border-radius:6px; background:var(--background); color:var(--text); font-size:0.85rem;">
      <button type="button" id="sm-adj-btn" onclick="submitStockAdjustment()" style="background:var(--primary); color:#fff; border:none; padding:7px 14px; border-radius:6px; cursor:pointer; font-size:0.85rem; font-weight:600; display:inline-flex; align-items:center; gap:6px; white-space:nowrap;">
        <i class="fa-solid fa-plus-minus"></i> Apply
      </button>
    </div>
  `;
}

async function submitStockAdjustment() {
  if (!_smProductId) return;
  const qtyInput = document.getElementById("sm-adj-qty");
  const noteInput = document.getElementById("sm-adj-note");
  const btn = document.getElementById("sm-adj-btn");
  const qty = parseInt(qtyInput ? qtyInput.value : 0, 10);
  const note = noteInput ? noteInput.value.trim() : "";

  if (!qty || isNaN(qty) || qty === 0) {
    showToast("Please enter a non-zero quantity (+5 to add, -3 to deduct)", "error");
    if (qtyInput) qtyInput.focus();
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
  }

  try {
    const res = await fetchAuth(`${API_URL}/products/${_smProductId}/movements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        qty,
        note: note || "Manual adjustment",
        movement_type: qty > 0 ? "RESTOCK" : "ADJUSTMENT"
      })
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Failed to record adjustment");
    }
    const result = await res.json();
    if (result && result.new_stock !== undefined) {
      _smCurrentStock = result.new_stock;
    } else {
      _smCurrentStock = Math.max(0, _smCurrentStock + qty);
    }
    const badgeEl = document.getElementById("sm-badge-stock");
    if (badgeEl) badgeEl.textContent = _smCurrentStock;

    showToast("Stock adjustment recorded successfully", "success");
    if (qtyInput) qtyInput.value = "";
    if (noteInput) noteInput.value = "";
    await _loadStockMovements();
    if (typeof loadInventory === "function") {
      loadInventory();
    }
  } catch (err) {
    console.error("Stock adjustment error:", err);
    showToast(err.message || "Failed to apply adjustment", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-plus-minus"></i> Apply';
    }
  }
}
window.submitStockAdjustment = submitStockAdjustment;

async function _loadStockMovements() {
  const content = document.getElementById("stock-movements-content");
  if (!content || !_smProductId) return;
  content.innerHTML = '<div style="text-align:center;padding:36px;color:var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Loading stock history...</div>';

  try {
    const res = await fetchAuth(`${API_URL}/products/${_smProductId}/movements`);
    if (!res.ok) throw new Error("Failed to load");
    const data = await res.json();
    const movements = data.movements || [];

    if (movements.length === 0) {
      content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);"><i class="fa-solid fa-clock-rotate-left" style="font-size:2rem;margin-bottom:10px;opacity:0.5;display:block;"></i>No stock movements logged yet for this product.<br><small style="opacity:0.8;">Sales, restocks, and manual adjustments will appear here automatically.</small></div>';
      return;
    }

    let rowsHtml = movements.map((m) => {
      const isSale = m.movement_type === "SALE";
      const isRestock = m.movement_type === "RESTOCK";
      const color = isSale ? "#EF4444" : isRestock ? "#10B981" : "#F59E0B";
      const bg = isSale ? "rgba(239,68,68,0.08)" : isRestock ? "rgba(16,185,129,0.08)" : "rgba(245,158,11,0.08)";
      const icon = isSale ? '<i class="fa-solid fa-arrow-trend-down"></i>' : isRestock ? '<i class="fa-solid fa-arrow-trend-up"></i>' : '<i class="fa-solid fa-arrow-right-arrow-left"></i>';
      const dt = m.created_at ? new Date(m.created_at).toLocaleString("en-UG", { timeZone: "Africa/Kampala" }) : "—";
      const qtyDisplay = (m.qty > 0 ? "+" : "") + m.qty;

      return `
        <tr style="border-bottom:1px solid var(--border);">
          <td style="padding:10px 8px; font-size:0.78rem; color:var(--text-muted); white-space:nowrap;">${dt}</td>
          <td style="padding:10px 8px; white-space:nowrap;"><span style="background:${bg}; color:${color}; border-radius:5px; padding:3px 8px; font-weight:700; font-size:0.78rem;">${icon} ${m.movement_type}</span></td>
          <td style="padding:10px 8px; text-align:right; font-weight:800; color:${color}; font-size:0.95rem;">${qtyDisplay}</td>
          <td style="padding:10px 8px; text-align:right; color:var(--text-muted);">${m.stock_before !== null && m.stock_before !== undefined ? m.stock_before : '—'}</td>
          <td style="padding:10px 8px; text-align:right; font-weight:700; color:var(--text);">${m.stock_after !== null && m.stock_after !== undefined ? m.stock_after : '—'}</td>
          <td style="padding:10px 8px; font-size:0.82rem; color:var(--text-muted); max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${(m.note || '').replace(/"/g, '&quot;')}">${m.note || '—'}</td>
          <td style="padding:10px 8px; font-size:0.82rem; color:var(--primary); font-weight:600;">${m.performed_by || '—'}</td>
        </tr>
      `;
    }).join("");

    content.innerHTML = `
      <table style="width:100%; border-collapse:collapse; font-size:0.85rem;">
        <thead>
          <tr style="background:var(--background); position:sticky; top:0; z-index:1; border-bottom:2px solid var(--border); text-align:left;">
            <th style="padding:8px; white-space:nowrap;">Date & Time</th>
            <th style="padding:8px;">Type</th>
            <th style="padding:8px; text-align:right;">Change</th>
            <th style="padding:8px; text-align:right;">Before</th>
            <th style="padding:8px; text-align:right;">After</th>
            <th style="padding:8px;">Details / Note</th>
            <th style="padding:8px;">By</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
  } catch (e) {
    console.error("Failed to load movements:", e);
    content.innerHTML = `<div style="color:var(--danger);padding:20px;text-align:center;">Failed to load movements: ${e.message || 'Please try again.'}</div>`;
  }
}
window._loadStockMovements = _loadStockMovements;

// ========================================================
// CASHIER EDIT PENDING ORDER — Register-based flow
// ========================================================
let _currentEditOrder = null;
let _editOrderItems = [];
let _editOrderOriginalQtys = {}; // tracks original item qtys to prevent reduction

async function openEditPendingOrder(posOrderId) {
  const _roleNow = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
  if (_roleNow === "CASHIER" && !window._hasActiveCashierShift) {
    const hasShift = await window.ensureCashierShiftActive("edit pending orders");
    if (!hasShift) return;
  }

  try {
    showToast('Loading order...', 'info');

    const [orderRes, itemsRes] = await Promise.all([
      fetchAuth(`${API_URL}/pos_orders/${posOrderId}`),
      fetchAuth(`${API_URL}/pos_orders/${posOrderId}/items`),
    ]);

    if (!orderRes.ok || !itemsRes.ok) throw new Error('Failed to load order');
    _currentEditOrder = await orderRes.json();
    const items = await itemsRes.json();

    // Store original quantities so edit mode can enforce minimum
    _editOrderOriginalQtys = {};
    posCart = items.map(i => {
      const itemId = i.id || i.product_id;
      const qty = Number(i.qty) || 1;
      _editOrderOriginalQtys[itemId] = qty;
      return {
        id: itemId,
        product_id: itemId,
        name: i.name || i.product_name,
        price: Number(i.price) || 0,
        qty,
        track_stock: 0,
      };
    });

    // Switch to Register view
    switchPOSView('register');
    renderCart();

    // Show editing banner in cart panel
    _showEditOrderBanner(posOrderId, _currentEditOrder);

    // Make sure the action button is visible and active for edit mode
    const btnPrintInvoice = document.getElementById("btn-print-invoice");
    const btnSendToCashier = document.getElementById("btn-send-to-cashier");
    const _role = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
    const isWaiterLevel = _role === "WAITER" || _role === "SUPERVISOR";
    if (isWaiterLevel) {
      if (btnSendToCashier) {
        btnSendToCashier.style.setProperty("display", "block", "important");
        btnSendToCashier.disabled = false;
        btnSendToCashier.style.opacity = "";
        btnSendToCashier.style.pointerEvents = "";
        btnSendToCashier.innerHTML = '<i class="fa-solid fa-print"></i> PRINT INVOICE';
      }
    } else {
      if (btnPrintInvoice) {
        btnPrintInvoice.style.setProperty("display", "block", "important");
        btnPrintInvoice.disabled = false;
        btnPrintInvoice.style.opacity = "";
        btnPrintInvoice.style.pointerEvents = "";
        btnPrintInvoice.innerHTML = '<i class="fa-solid fa-print"></i> PRINT INVOICE';
      }
    }

    const invLabel = formatDocNo("INV", _currentEditOrder.invoice_number || posOrderId);
    showToast(`Editing Order ${invLabel} — add/remove items then tap PRINT INVOICE or Save`, 'warning');
  } catch (e) {
    alert('Error loading order: ' + e.message);
  }
}
window.openEditPendingOrder = openEditPendingOrder;

window.printEditOrderKitchenToken = function () {
  return submitWaiterOrder();
};

function _showEditOrderBanner(posOrderId, order) {
  // Remove any existing banner
  const existing = document.getElementById('edit-order-banner');
  if (existing) existing.remove();

  const invLabel = formatDocNo("INV", order.invoice_number || posOrderId);

  const banner = document.createElement('div');
  banner.id = 'edit-order-banner';
  banner.style.cssText = 'background:#f59e0b;color:#000;padding:10px 14px;border-radius:8px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:700;font-size:0.85rem;box-shadow:0 2px 8px rgba(0,0,0,0.2);flex-wrap:wrap;';

  const buttonsHtml = `
    <button onclick="submitWaiterOrder()" id="btn-save-edit-order" style="background:#16a34a;color:#fff;border:none;padding:6px 14px;border-radius:6px;font-weight:700;cursor:pointer;font-size:0.82rem;">
      <i class="fa-solid fa-floppy-disk"></i> Save & Print Token
    </button>
    <button onclick="cancelEditOrder()" style="background:#dc2626;color:#fff;border:none;padding:6px 12px;border-radius:6px;font-weight:700;cursor:pointer;font-size:0.82rem;">
      <i class="fa-solid fa-xmark"></i> Cancel
    </button>
  `;

  banner.innerHTML = `
    <span style="display:flex;align-items:center;gap:7px;">
      <i class="fa-solid fa-pen-to-square"></i>
      EDITING Order ${invLabel}&nbsp;&bull;&nbsp;${order.buyer_name || 'Walk-in'}
    </span>
    <span style="display:flex;gap:8px;flex-wrap:wrap;">
      ${buttonsHtml}
    </span>
  `;

  // Insert before #cart-items inside .pos-cart
  const cartItems = document.getElementById('cart-items');
  if (cartItems && cartItems.parentNode) {
    cartItems.parentNode.insertBefore(banner, cartItems);
  }
}
window._showEditOrderBanner = _showEditOrderBanner;

function cancelEditOrder() {
  const banner = document.getElementById('edit-order-banner');
  if (banner) banner.remove();
  _currentEditOrder = null;
  _editOrderItems = [];
  _editOrderOriginalQtys = {};
  posCart = [];
  renderCart();
  const btnPrintInvoice = document.getElementById("btn-print-invoice");
  const _role = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
  const isWaiterLevel = _role === "WAITER" || _role === "SUPERVISOR";
  if (btnPrintInvoice) btnPrintInvoice.style.setProperty("display", isWaiterLevel ? "none" : "block", "important");
  switchPOSView('pending');
}
window.cancelEditOrder = cancelEditOrder;

// kept for backward compat
function closeEditPendingOrderModal() {
  cancelEditOrder();
}
window.closeEditPendingOrderModal = closeEditPendingOrderModal;

async function saveEditedPendingOrder() {
  if (!_currentEditOrder) return;
  return submitWaiterOrder();
}
window.saveEditedPendingOrder = saveEditedPendingOrder;


// Opens the standard payment panel pre-filled for a pending order (Cashier collects payment)
window.openPendingOrderCheckout = async function (posOrderId, totalAmount, clientName, servedBy) {
  const _roleNow = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
  if (_roleNow === "CASHIER" && !window._hasActiveCashierShift) {
    const hasShift = await window.ensureCashierShiftActive("collect payment for orders");
    if (!hasShift) return;
  }

  // 1. Switch to Register view first so the cart is visible
  switchPOSView("register");

  // Store server info for receipt and payment display
  window._pendingServedBy = servedBy || null;
  const servedByContainer = document.getElementById("pay-served-by-container");
  const servedByName = document.getElementById("pay-served-by-name");
  if (servedByContainer && servedByName) {
    if (servedBy) {
      servedByName.textContent = servedBy;
      servedByContainer.style.display = "block";
    } else {
      servedByContainer.style.display = "none";
    }
  }

  // 2. Fetch the actual order items and populate the cart
  try {
    const itemsRes = await fetchAuth(`${API_URL}/pos_orders/${posOrderId}/items`);
    if (itemsRes.ok) {
      const items = await itemsRes.json();
      if (items && items.length > 0) {
        posCart = items.map((i) => ({
          id: i.id || i.product_id,
          name: i.name,
          price: i.price,
          qty: i.qty,
          track_stock: 0,
        }));
        renderCart();
      }
    }
  } catch (e) {
    console.warn("Could not load order items:", e);
  }

  // 3. Store which pending order we're collecting for
  window._pendingOrderId = posOrderId;
  window._pendingOrderTotal = totalAmount;

  // Pre-fill the payment panel total display
  document.getElementById("pay-total").textContent =
    "UGX " + Math.round(totalAmount).toLocaleString();
  document.getElementById("pay-amount").value = "0";
  document.getElementById("pay-change").textContent = "UGX 0";
  document.getElementById("pay-change").style.color = "var(--text-muted)";

  const btnCheckout = document.getElementById("btn-checkout");
  if (btnCheckout) btnCheckout.setAttribute("data-total", Math.round(totalAmount));

  const buyerInput = document.getElementById("buyer-name-input");
  if (buyerInput) buyerInput.value = clientName || "";

  // Show the payment panel
  const panel = document.getElementById("payment-panel");
  if (panel) panel.classList.remove("hidden");

  // Swap confirm button to collect this pending payment
  const btnConfirm = document.getElementById("btn-confirm-pay");
  if (btnConfirm) {
    btnConfirm.setAttribute("data-pending-id", posOrderId);
    btnConfirm.onclick = () => collectPendingPayment(posOrderId, totalAmount);
  }
};

let _isCollectingPending = false;

// Called when cashier confirms payment for a pending order
window.collectPendingPayment = async function (posOrderId, totalAmount) {
  if (_isCollectingPending) return;
  const _roleNow = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
  if (_roleNow === "CASHIER") {
    const hasShift = await window.ensureCashierShiftActive("collect payments");
    if (!hasShift) return;
  }
  const paymentMethodSelect = document.getElementById("payment-method-select");
  const paymentMethod = (paymentMethodSelect ? paymentMethodSelect.value : "CASH").toUpperCase();
  const paid = parseInt(document.getElementById("pay-amount").value) || 0;
  const buyerName = document.getElementById("buyer-name-input")?.value?.trim() || "";
  const buyerPhone = document.getElementById("buyer-phone-input")?.value?.trim() || "";

  let splitCash = 0;
  let splitSec = 0;
  let splitSecMethod = "MOBILE MONEY";

  if (paymentMethod === "SPLIT") {
    splitCash = parseFloat(document.getElementById("split-cash-amount")?.value) || 0;
    if (splitCash < 0) {
      alert("Cash amount cannot be negative!");
      return;
    }
    if (splitCash > Math.round(totalAmount)) {
      alert(`Cash amount (UGX ${splitCash.toLocaleString()}) cannot exceed total due (UGX ${Math.round(totalAmount).toLocaleString()})!`);
      return;
    }
    splitSec = Math.max(0, Math.round(totalAmount) - splitCash);
    splitSecMethod = document.getElementById("split-second-method")?.value || "MOBILE MONEY";
    if (splitSecMethod === "CREDIT" && !buyerName) {
      alert("Please enter Customer / Buyer Name for the remaining Credit balance.");
      return;
    }
  } else if (paymentMethod === "CREDIT") {
    if (!buyerName) {
      alert("Please enter a Customer / Buyer Name for Credit transactions.");
      return;
    }
    if (paid > Math.round(totalAmount)) {
      alert("For credit, deposit paid cannot exceed the total amount.");
      return;
    }
  } else if (paid < Math.round(totalAmount)) {
    alert("Amount paid is less than total! Customer still owes UGX " + (Math.round(totalAmount) - paid).toLocaleString());
    return;
  }

  const btnConfirm = document.getElementById("btn-confirm-pay");
  const origBtnHtml = btnConfirm ? btnConfirm.innerHTML : "";
  _isCollectingPending = true;
  if (btnConfirm) {
    btnConfirm.disabled = true;
    btnConfirm.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
  }

  try {
    const effectivePaid = paymentMethod === "CREDIT" && paid >= Math.round(totalAmount) ? 0 : paid;
    const res = await fetchAuth(`${API_URL}/pos_orders/${posOrderId}/cod-received`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payment_method: paymentMethod,
        amount_paid: effectivePaid,
        buyer_name: buyerName,
        buyer_phone: buyerPhone,
        split_cash_amount: splitCash,
        split_second_amount: splitSec,
        split_second_method: splitSecMethod,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      // Reset confirm button back to normal checkout
      if (btnConfirm) {
        btnConfirm.removeAttribute("data-pending-id");
        btnConfirm.onclick = () => confirmPayment();
      }
      window._pendingOrderId = null;
      window._pendingOrderTotal = null;

      closePaymentPanel();
      showToast("Payment collected!", "success");
      loadPendingCOD(true); // force=true: bypass cache after payment collection
      if (paymentMethod === "CREDIT" && typeof loadCredits === "function") {
        loadCredits();
      }

      const receiptItems = posCart.length > 0 ? [...posCart] : [{ name: "Invoice Payment", qty: 1, price: data.total_amount }];
      const serverName = data.served_by || window._pendingServedBy || null;

      // Clear the cart so the cashier starts fresh for the next sale
      posCart = [];
      renderCart();

      if (data.transaction_id && data.total_amount) {
        // Use unique transaction receipt_no for payment receipt
        const rcptNo = data.receipt_no || data.transaction_id;
        printReceipt(
          receiptItems,
          data.total_amount,
          rcptNo,
          paymentMethod,
          paid,
          data.client_name || "",
          null,
          false,
          serverName
        );
      }
    } else {
      alert("Error: " + data.error);
    }
  } catch (e) {
    console.error("Failed to collect pending payment:", e);
  } finally {
    _isCollectingPending = false;
    if (btnConfirm) {
      btnConfirm.disabled = false;
      btnConfirm.innerHTML = origBtnHtml || '<i class="fa-solid fa-check"></i> CONFIRM PAYMENT';
    }
  }
};

window.markCODReceived = async function (posOrderId) {
  if (!confirm("Are you sure you have received the cash for this order?"))
    return;

  try {
    const res = await fetchAuth(
      `${API_URL}/pos_orders/${posOrderId}/cod-received`,
      { method: "POST" },
    );
    const data = await res.json();

    if (res.ok) {
      showToast("Payment Marked as Received", "success");
      loadPendingCOD(true); // force=true: bypass cache after COD received

      // Generate a receipt for the received COD
      if (data.transaction_id && data.total_amount) {
        const deliveryItem = [
          {
            name: `COD Order Delivery`,
            qty: 1,
            price: data.total_amount,
          },
        ];
        const deliveryInfo = `Location: ${data.client_location || "N/A"}`;

        printReceipt(
          deliveryItem,
          data.total_amount,
          data.receipt_no || data.transaction_id,
          "COD (Received)",
          data.total_amount,
          data.client_name,
          deliveryInfo,
        );
      }
    } else {
      alert("Error: " + data.error);
    }
  } catch (e) {
    console.error("Failed to mark COD received:", e);
  }
};

// Hook into existing events
document.addEventListener("DOMContentLoaded", () => {
  // Initial load — only for Cashier and Tech roles
  const _initRole = (localStorage.getItem("jomish_role") || "").toUpperCase();
  if (
    (_initRole === "CASHIER" || _initRole === "TECH") &&
    (
      window.location.pathname.includes("index") ||
      window.location.pathname === "/"
    )
  ) {
    setTimeout(() => loadPendingCOD(), 1000);
  }
});

// =============================================
// TECH SUPPORT ACCOUNTS MANAGEMENT (Tech Hub)
// =============================================
async function loadTechUsers() {
  try {
    const res = await fetchAuth(`${API_URL}/system/tech_users`);
    if (!res.ok) throw new Error("Failed to load tech users");
    const data = await res.json();

    const tbody = document.getElementById("tech-users-table-body");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (!data.tech_users || data.tech_users.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="3" style="text-align:center; padding:20px; color:var(--text-muted);">No tech accounts found.</td></tr>';
      return;
    }

    data.tech_users.forEach((u) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
                <td style="font-weight:bold;">${u.username}</td>
                <td>${formatDisplayDate(u.created_at)}</td>
                <td>
                    ${u.username !== window.USER_NAME && u.username !== "tech" ? `<button class="sm-btn danger" onclick="deleteTechUser(${u.id}, '${u.username}')">Delete</button>` : `<span style="font-size:0.8rem; color:var(--text-muted);">(protected)</span>`}
                </td>
            `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error("Error loading tech users:", e);
  }
}

async function createTechUser() {
  const userInp = document.getElementById("new-tech-username");
  const passInp = document.getElementById("new-tech-password");
  const username = userInp.value.trim();
  const password = passInp.value;

  if (!username || !password) {
    return showToast("Username and password are required", "error");
  }

  try {
    const res = await fetchAuth(`${API_URL}/system/tech_users`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to create tech user");

    showToast("Tech account created successfully", "success");
    userInp.value = "";
    passInp.value = "";
    loadTechUsers();
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function deleteTechUser(id, username) {
  if (!confirm(`Are you sure you want to delete tech account '${username}'?`))
    return;
  try {
    const res = await fetchAuth(`${API_URL}/system/tech_users/${id}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to delete tech user");

    showToast("Tech account deleted", "success");
    loadTechUsers();
  } catch (e) {
    showToast(e.message, "error");
  }
}

// =============================================
// MULTI-TENANT COMPANIES MANAGEMENT (Tech Hub)
// =============================================

async function loadCompanies() {
  try {
    const res = await fetchAuth(`${API_URL}/system/companies`);
    const data = await res.json();
    const tbody = document.getElementById("companies-table-body");
    if (!tbody) return;

    if (!data.companies || data.companies.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:24px;">No companies registered yet. Click "Register Company" to get started.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.companies
      .map((c) => {
        const prefix = c.prefix || "—";
        const schema = `t_${prefix.toLowerCase()}`;
        const loginFormat = `${prefix}00001`;
        const date = c.created_at
          ? new Date(c.created_at).toLocaleDateString()
          : "—";
        const status = c.status || "ACTIVE";
        const statusColor = status === "ACTIVE" ? "#22c55e" : "#ef4444";

        return `<tr>
                <td><span style="background:rgba(79,70,229,0.12); color:#4F46E5; padding:3px 10px; border-radius:6px; font-weight:800; letter-spacing:1px; font-family:'Courier New',monospace;">${prefix}</span></td>
                <td><strong>${c.name || "—"}</strong></td>
                <td><code style="background:var(--surface); padding:3px 8px; border-radius:4px; font-size:0.82rem;">${loginFormat}</code> – <code style="background:var(--surface); padding:3px 8px; border-radius:4px; font-size:0.82rem;">${prefix}99999</code></td>
                <td><code style="color:#94A3B8; font-size:0.8rem;">${schema}</code></td>
                <td style="color:var(--text-muted); font-size:0.85rem;">${date}</td>
                <td><span style="background:${statusColor}22; color:${statusColor}; padding:2px 8px; border-radius:12px; font-size:0.75rem; font-weight:bold;">${status}</span></td>
                <td>
                    <button onclick="toggleCompanyStatus('${prefix}', '${status}')" style="background:transparent; border:none; color:var(--text); cursor:pointer; margin-right:8px;" title="${status === "ACTIVE" ? "Pause Company" : "Resume Company"}">
                        <i class="fa-solid ${status === "ACTIVE" ? "fa-pause" : "fa-play"}"></i>
                    </button>
                    <button onclick="deleteCompany('${prefix}')" style="background:transparent; border:none; color:#ef4444; cursor:pointer;" title="Delete Company">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </td>
            </tr>`;
      })
      .join("");
  } catch (e) {
    console.error("[Companies] Load failed:", e);
  }
}

async function toggleCompanyStatus(prefix, currentStatus) {
  const newStatus = currentStatus === "ACTIVE" ? "PAUSED" : "ACTIVE";
  if (
    !confirm(
      `Are you sure you want to ${newStatus === "PAUSED" ? "pause" : "resume"} the company ${prefix}?`,
    )
  )
    return;

  try {
    const res = await fetchAuth(`${API_URL}/system/companies/${prefix}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: newStatus }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    loadCompanies();
  } catch (e) {
    alert(e.message);
  }
}

async function deleteCompany(prefix) {
  if (
    !confirm(
      `WARNING: You are about to PERMANENTLY DELETE the company ${prefix} and all its data. This action cannot be undone. Are you absolutely sure?`,
    )
  )
    return;

  try {
    const res = await fetchAuth(`${API_URL}/system/companies/${prefix}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    loadTechTenants();
  } catch (e) {
    alert(e.message);
  }
}

function openNewCompanyModal() {
  document.getElementById("new-company-modal").classList.remove("hidden");
  document.getElementById("new-company-result").style.display = "none";
  document.getElementById("new-company-name").value = "";
  document.getElementById("new-company-prefix").value = "";
  document.getElementById("new-company-preview").textContent = "XXX00001";

  const prefixInput = document.getElementById("new-company-prefix");
  prefixInput.oninput = function () {
    const val = this.value.toUpperCase().replace(/[^A-Z]/g, "");
    this.value = val;
    document.getElementById("new-company-preview").textContent = val
      ? `${val}00001`
      : "XXX00001";
  };
}

async function submitNewCompany() {
  const name = document.getElementById("new-company-name").value.trim();
  const prefix = document
    .getElementById("new-company-prefix")
    .value.trim()
    .toUpperCase();
  const techPass = "Jomish9!!";
  const resultEl = document.getElementById("new-company-result");
  const btn = document.getElementById("btn-submit-new-company");

  if (!name || !prefix) {
    resultEl.style.display = "block";
    resultEl.style.background = "rgba(239,68,68,0.1)";
    resultEl.style.border = "1px solid rgba(239,68,68,0.3)";
    resultEl.style.color = "#f87171";
    resultEl.textContent = "Company name and prefix are required.";
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Provisioning...';

  try {
    const res = await fetchAuth(`${API_URL}/system/initialize`, {
      method: "POST",
      body: JSON.stringify({
        company_name: name,
        company_prefix: prefix,
        tech_password: techPass,
      }),
    });
    const data = await res.json();

    resultEl.style.display = "block";
    if (res.ok) {
      resultEl.style.background = "rgba(16,185,129,0.1)";
      resultEl.style.border = "1px solid rgba(16,185,129,0.3)";
      resultEl.style.color = "#34d399";
      resultEl.innerHTML = `<strong>Company provisioned successfully!</strong><br>First Login ID: <strong>${data.tech_username}</strong><br>Default Password: <strong>${data.default_password}</strong><br><span style="color:#F59E0B;">Change this password after first login.</span>`;
      loadCompanies();
    } else {
      resultEl.style.background = "rgba(239,68,68,0.1)";
      resultEl.style.border = "1px solid rgba(239,68,68,0.3)";
      resultEl.style.color = "#f87171";
      resultEl.textContent = data.error || "Provisioning failed.";
    }
  } catch (e) {
    resultEl.style.display = "block";
    resultEl.style.color = "#f87171";
    resultEl.textContent = "Network error. Is the server running?";
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-database"></i> Provision Company';
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document
    .querySelectorAll('.nav-btn[data-target="tech-hub"]')
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        setTimeout(() => {
          loadCompanies();
          loadTechUsers();
        }, 300);
      });
    });
});

// ===== OFFLINE SYNC LOGIC =====
let isSyncing = false;
async function syncOfflineMutations() {
  if (!navigator.onLine || !window.OfflineDB || isSyncing) return;
  isSyncing = true;
  try {
    const mutations = await window.OfflineDB.getQueuedMutations();
    if (mutations.length > 0) {
      console.log(
        `[Offline Sync] Found ${mutations.length} pending mutations to sync.`,
      );
      showToast("Syncing offline changes...", "info");
      for (const m of mutations) {
        try {
          const res = await fetch(m.url, {
            method: m.method,
            headers: m.headers,
            body: m.body,
          });
          if (res.ok) {
            await window.OfflineDB.removeQueuedMutation(m.id);
          } else {
            console.error(
              `[Offline Sync] Failed to replay mutation ${m.id} - Status: ${res.status}`,
            );
            // If it's a 4xx error (like 400 Bad Request), it might never succeed. Remove it to prevent endless loops.
            if (res.status >= 400 && res.status < 500) {
              await window.OfflineDB.removeQueuedMutation(m.id);
            }
          }
        } catch (e) {
          console.error(
            `[Offline Sync] Network error while replaying ${m.id}:`,
            e,
          );
          // Network error, stop syncing for now, retry later.
          break;
        }
      }
      showToast("Offline changes synced successfully.", "success");
      // Refresh current view if applicable to fetch updated IDs
      if (typeof loadEmployees === "function" && currentView === "hr")
        loadEmployees();
    }
  } catch (e) {
    console.error("[Offline Sync] Sync failed:", e);
  } finally {
    isSyncing = false;
  }
}

window.addEventListener("online", () => {
  showToast("Network restored. Syncing...", "success");
  syncOfflineMutations();
  setTimeout(syncOfflineSales, 1500);
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "TRIGGER_SYNC") {
      syncOfflineMutations();
      syncOfflineSales();
    }
  });
}

// Also try syncing on initial load if online
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(syncOfflineMutations, 2000);
  setTimeout(syncOfflineSales, 2500);
});

// ===== PWA & Push Notifications =====
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        subscribeToPush(reg);
      })
      .catch((err) => {
        console.error("[PWA] Service Worker registration failed:", err);
      });
  });
}

const PUBLIC_VAPID_KEY =
  "BDpy4RrJ8ch4fFlX6BeLYhXzFXhOvldEnzIsAvFW_vDqAloZ87zcLynHJvy9qrk6n17MJy8dpMhfAD-gAsZ4FbY";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, "+")
    .replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function subscribeToPush(registration) {
  try {
    if (!window.USER_ID) return; // Only subscribe if logged in
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(PUBLIC_VAPID_KEY),
      });
    }
    // Send subscription to server
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + localStorage.getItem("jomish_token"),
      },
      body: JSON.stringify(subscription),
    });
  } catch (e) {
    console.error("[PUSH] Failed to subscribe to push:", e);
  }
}

// ==========================================
// WhatsApp Integration (Secretary Hub)
// ==========================================

/**
 * Fetches current WhatsApp status from the server REST endpoint and updates
 * the UI accordingly.  Called every time the user switches to the WhatsApp
 * view so that the QR code is shown even if the socket event fired before
 * the browser connected.
 */
async function loadWhatsAppStatus() {
  try {
    const status = await fetchAuth("/api/whatsapp/status");
    if (!status) return;

    const loadingEl = document.getElementById("whatsapp-loading");
    const qrImg = document.getElementById("whatsapp-qr-img");
    const notReady = document.getElementById("whatsapp-not-ready");
    const ready = document.getElementById("whatsapp-ready");
    if (!loadingEl || !qrImg || !notReady || !ready) return;

    if (status.ready) {
      // Already authenticated
      notReady.style.display = "none";
      ready.style.display = "flex";
    } else if (status.qr) {
      // QR exists on the server — generate a data-URL from it
      try {
        // Use the /api/whatsapp/qr endpoint if available, otherwise
        // fall back to asking the server to regenerate via socket.
        const qrRes = await fetch("/api/whatsapp/qr");
        if (qrRes.ok) {
          const { qrDataUrl } = await qrRes.json();
          loadingEl.style.display = "none";
          qrImg.src = qrDataUrl;
          qrImg.style.display = "block";
          notReady.style.display = "flex";
          ready.style.display = "none";
        }
      } catch (_) {
        // /api/whatsapp/qr not yet available — show spinner and wait
        // for socket event
        loadingEl.style.display = "block";
        qrImg.style.display = "none";
      }
    } else {
      // Not ready and no QR yet — keep spinner
      loadingEl.style.display = "block";
      qrImg.style.display = "none";
      notReady.style.display = "flex";
      ready.style.display = "none";
    }
  } catch (err) {
    console.error("loadWhatsAppStatus error", err);
  }
}

// Real-time updates via socket (fires for NEW QR codes while the page is open)
if (window.socket) {
  window.socket.on("whatsapp_qr", (qrDataUrl) => {
    const loadingEl = document.getElementById("whatsapp-loading");
    const qrImg = document.getElementById("whatsapp-qr-img");
    const notReady = document.getElementById("whatsapp-not-ready");
    const ready = document.getElementById("whatsapp-ready");
    if (!loadingEl || !qrImg || !notReady || !ready) return;
    loadingEl.style.display = "none";
    qrImg.src = qrDataUrl;
    qrImg.style.display = "block";
    notReady.style.display = "flex";
    ready.style.display = "none";
  });

  window.socket.on("whatsapp_ready", () => {
    const notReady = document.getElementById("whatsapp-not-ready");
    const ready = document.getElementById("whatsapp-ready");
    if (notReady) notReady.style.display = "none";
    if (ready) ready.style.display = "flex";
  });

  window.socket.on("whatsapp_disconnected", () => {
    const notReady = document.getElementById("whatsapp-not-ready");
    const ready = document.getElementById("whatsapp-ready");
    const qrImg = document.getElementById("whatsapp-qr-img");
    const loadingEl = document.getElementById("whatsapp-loading");
    if (notReady) notReady.style.display = "flex";
    if (ready) ready.style.display = "none";
    if (qrImg) qrImg.style.display = "none";
    if (loadingEl) loadingEl.style.display = "block";
  });

  window.socket.on("whatsapp_message", (msg) => {
    const inbox = document.getElementById("whatsapp-inbox");
    if (!inbox) return;
    const msgDiv = document.createElement("div");
    msgDiv.style.padding = "10px";
    msgDiv.style.background = "var(--surface)";
    msgDiv.style.borderRadius = "8px";
    msgDiv.style.border = "1px solid var(--border)";
    msgDiv.innerHTML = `
            <div style="font-size:0.8rem; color:#94A3B8; margin-bottom:4px;">From: ${msg.from}</div>
            <div style="color:var(--text);">${msg.body}</div>
        `;
    inbox.prepend(msgDiv);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const waForm = document.getElementById("form-whatsapp-send");
  if (waForm) {
    waForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const to = document.getElementById("wa-to").value;
      const message = document.getElementById("wa-msg").value;

      try {
        const res = await fetchAuth("/api/whatsapp/send", {
          method: "POST",
          body: JSON.stringify({ to, message }),
        });

        if (res && res.success) {
          showToast("WhatsApp message sent successfully", "success");
          document.getElementById("wa-msg").value = "";
        } else {
          showToast(res.error || "Failed to send message", "error");
        }
      } catch (err) {
        console.error(err);
        showToast("Error sending message", "error");
      }
    });
  }
});

// ===== JomishPOS: Toggle between POS and SME Finance =====
function toggleSmeFinanceMode() {
  const pos = document.getElementById("pos-terminal");
  const sme = document.getElementById("sme-business");
  if (!pos || !sme) return;
  if (sme.classList.contains("active")) {
    sme.classList.remove("active");
    pos.classList.add("active");
    const role = (USER_ROLE || "").toUpperCase();
    if (role === "TECH") {
      switchPOSView("tech");       // Tech → Tech Hub
    } else if (role === "CASHIER" || role === "WAITER" || role === "SUPERVISOR") {
      switchPOSView("register");   // Cashier / Waiter / Supervisor → Register
    } else if (["CEO", "ADMIN", "MANAGER", "FINANCE MANAGER"].includes(role)) {
      switchPOSView("stock");      // Admin-like → Inventory
    } else if (role === "HR") {
      switchPOSView("expenses");   // HR → Expenses
    } else {
      switchPOSView("stock");      // fallback
    }
  } else {
    pos.classList.remove("active");
    sme.classList.add("active");
    const _role = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
    const canSeeInvoices = ["CEO", "MANAGER", "SUPERVISOR", "ADMIN", "TECH"].includes(_role) || USER_NAME === "System Technician";
    const btnInv = document.getElementById("btn-sme-invoices");
    if (btnInv) btnInv.style.display = canSeeInvoices ? "inline-flex" : "none";
    loadTransactions();
    if (canSeeInvoices) loadCustomerInvoices();
  }
}

// ============================================================
// TECH HUB — Multi-Tenant Company Management
// Only visible when logged in as the global 'tech' account
// ============================================================

async function loadTechTenants() {
  const container = document.getElementById("tech-tenants-list");
  if (!container) return;
  container.innerHTML =
    '<div style="text-align:center;padding:20px;color:var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Loading companies...</div>';
  try {
    const res = await fetchAuth(`${API_URL}/tech/tenants`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const tenants = data.tenants || [];
    if (tenants.length === 0) {
      container.innerHTML =
        '<div style="text-align:center;padding:40px;color:var(--text-muted);"><i class="fa-solid fa-building-circle-xmark" style="font-size:2rem;margin-bottom:10px;display:block;"></i> No companies provisioned yet.<br>Create one using the form on the right.</div>';
      return;
    }
    container.innerHTML = tenants
      .map(
        (t) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border:1px solid var(--border);border-radius:10px;margin-bottom:10px;background:var(--surface);">
            <div>
                <div style="display:flex;align-items:center;gap:10px;">
                    <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#8b5cf6);display:flex;align-items:center;justify-content:center;color:white;font-weight:800;font-size:0.85rem;">${(t.prefix || "?").substring(0, 3).toUpperCase()}</div>
                    <div>
                        <div style="font-weight:700;">${t.company_name || t.prefix || "Unknown"}</div>
                        <div style="font-size:0.8rem;color:var(--text-muted);">Login prefix: <code style="background:var(--bg-color);padding:1px 6px;border-radius:4px;">${(t.prefix || "").toUpperCase()}001</code></div>
                    </div>
                </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
                <span style="padding:3px 10px;border-radius:99px;font-size:0.75rem;font-weight:700;background:#d1fae5;color:#065f46;">ACTIVE</span>
                <button class="secondary-btn" onclick="techResetCEO('${(t.prefix || "").toUpperCase()}')" style="padding:6px 12px;font-size:0.8rem;"><i class="fa-solid fa-key"></i> Reset CEO</button>
                <button onclick="deleteCompany('${(t.prefix || "").toUpperCase()}')" style="background:transparent; border:none; color:#ef4444; cursor:pointer; font-size:1.1rem; margin-left:5px;" title="Delete Company">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>`,
      )
      .join("");
  } catch (e) {
    container.innerHTML = `<div style="color:var(--danger);padding:15px;border-radius:8px;background:#fef2f2;border:1px solid #fecaca;"><i class="fa-solid fa-triangle-exclamation"></i> ${e.message}</div>`;
  }
}

async function handleCreateTenant(event) {
  event.preventDefault();
  const nameInput = document.getElementById("tech-new-company-name");
  const adminNameInput = document.getElementById("tech-admin-name");
  const adminTitleInput = document.getElementById("tech-admin-title");
  const adminEmailInput = document.getElementById("tech-admin-email");
  const adminPasswordInput = document.getElementById("tech-admin-password");
  const statusEl = document.getElementById("tech-create-status");
  const btn = event.target.querySelector('button[type="submit"]');

  const companyName = nameInput.value.trim();
  const adminName = adminNameInput.value.trim();
  const adminTitle = adminTitleInput.value.trim();
  const email = adminEmailInput.value.trim();
  const password = adminPasswordInput.value.trim();

  if (!companyName || !adminName || !email || !password) return;

  // Auto-generate a prefix (e.g. first 3 letters of company + random letter)
  const lettersOnly = companyName.replace(/[^A-Za-z]/g, "");
  const baseStr = lettersOnly.length >= 3 ? lettersOnly.substring(0, 3).toUpperCase() : "COM";
  const randomLetter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const prefix = baseStr + randomLetter;

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Provisioning...';

  try {
    const res = await fetchAuth(`${API_URL}/tech/tenant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_name: companyName,
        prefix,
        admin_name: adminName,
        admin_title: adminTitle,
        email: email,
        password: password,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to create portal");

    showTechStatus(
      "success",
      `
            <i class="fa-solid fa-check-circle"></i> <strong>Portal created successfully!</strong><br>
            <div style="margin-top:10px; font-size:0.9rem;">
                Company: <strong>${companyName}</strong><br>
                Admin Login: <code style="background:rgba(255,255,255,0.3);padding:2px 8px;border-radius:4px;">${email}</code><br>
                Password: <code style="background:rgba(255,255,255,0.3);padding:2px 8px;border-radius:4px;">${password}</code><br>
                <small style="opacity:0.8;">Admin can now log in using the email and PIN above.</small>
            </div>
        `,
    );

    nameInput.value = "";
    adminNameInput.value = "";
    adminTitleInput.value = "";
    adminEmailInput.value = "";
    adminPasswordInput.value = "";
    loadTechTenants(); // Refresh the list
  } catch (e) {
    showTechStatus(
      "error",
      `<i class="fa-solid fa-triangle-exclamation"></i> ${e.message}`,
    );
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-rocket"></i> Provision Portal';
  }
}

async function techResetCEO(prefix) {
  if (
    !confirm(
      `Reset the CEO password for company "${prefix}"?\nNew password will be "password".`,
    )
  )
    return;
  try {
    const res = await fetchAuth(`${API_URL}/tech/tenant/${prefix}/reset-ceo`, {
      method: "POST",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Reset failed");
    showToast(`CEO password for ${prefix} reset to "password"`, "success");
  } catch (e) {
    showToast(e.message, "error");
  }
}

function showTechStatus(type, html) {
  const el = document.getElementById("tech-create-status");
  if (!el) return;
  el.style.display = "block";
  el.style.background =
    type === "success" ? "linear-gradient(135deg,#10b981,#059669)" : "#fef2f2";
  el.style.color = type === "success" ? "white" : "#991b1b";
  el.style.border = type === "success" ? "none" : "1px solid #fecaca";
  el.innerHTML = html;
}

// ── Launch Kiosk Mode (Tech Hub) ──
async function launchKioskMode() {
  const browser = document.getElementById("tech-kiosk-browser").value;
  try {
    const res = await fetchAuth(`${API_URL}/tech/kiosk`, {
      method: "POST",
      body: JSON.stringify({ browser }),
    });
    const data = await res.json();
    if (res.ok) {
      showToast("Kiosk launched on the server machine!", "success");
    } else {
      alert("Error: " + (data.error || "Failed to launch kiosk."));
    }
  } catch (e) {
    alert("Network error. Could not connect to server.");
  }
}

// ── Change PIN Modal Logic ──
function openChangePinModal() {
  document.getElementById("change-pin-modal").classList.remove("hidden");
  document.getElementById("change-pin-current").value = "";
  document.getElementById("change-pin-new").value = "";
  document.getElementById("change-pin-confirm").value = "";
  document.getElementById("change-pin-error").style.display = "none";
}

function closeChangePinModal() {
  document.getElementById("change-pin-modal").classList.add("hidden");
}

async function submitChangePin() {
  const currentPin = document.getElementById("change-pin-current").value.trim();
  const newPin = document.getElementById("change-pin-new").value.trim();
  const confirmPin = document.getElementById("change-pin-confirm").value.trim();
  const errorEl = document.getElementById("change-pin-error");

  // Validate 4-digit numeric PIN
  const pinRegex = /^[0-9]{4}$/;
  if (!pinRegex.test(newPin)) {
    errorEl.textContent = "New PIN must be exactly 4 digits (numbers only).";
    errorEl.style.display = "block";
    return;
  }
  if (newPin !== confirmPin) {
    errorEl.textContent = "New PIN and Confirm PIN do not match.";
    errorEl.style.display = "block";
    return;
  }

  try {
    const res = await fetchAuth(`${API_URL}/employees/me/pin`, {
      method: "POST",
      body: JSON.stringify({ currentPin, newPin }),
    });
    const data = await res.json();
    if (res.ok) {
      closeChangePinModal();
      showToast("PIN changed successfully!", "success");
    } else {
      errorEl.textContent = data.error || "Failed to change PIN.";
      errorEl.style.display = "block";
    }
  } catch (e) {
    errorEl.textContent = "Network error connecting to server.";
    errorEl.style.display = "block";
  }
}



// ── CUSTOMER INVOICES IN FINANCIAL HUB (Supervisor & CEO only) ─────────────
let _allCustomerInvoices = [];

window.loadCustomerInvoices = async function(searchTerm = "") {
  try {
    const res = await fetchAuth(`${API_URL}/customer-invoices`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn("Customer invoices load:", err.error);
      return;
    }
    const invoices = await res.json();
    _allCustomerInvoices = invoices || [];
    
    // Update badge in SME portal header
    const badge = document.getElementById("sme-invoice-badge");
    if (badge) {
      if (_allCustomerInvoices.length > 0) {
        badge.style.display = "inline-block";
        badge.textContent = _allCustomerInvoices.length;
      } else {
        badge.style.display = "none";
      }
    }

    renderCustomerInvoicesTable(searchTerm);
  } catch (e) {
    console.error("loadCustomerInvoices error:", e);
  }
};

window.renderCustomerInvoicesTable = function(searchTerm = "") {
  const tbody = document.getElementById("customer-invoices-tbody");
  if (!tbody) return;

  let list = _allCustomerInvoices;
  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    list = list.filter(i => 
      String(i.invoice_number || i.pos_order_id || "").includes(q) ||
      (i.client_name || "").toLowerCase().includes(q) ||
      (i.client_phone || "").includes(q) ||
      (i.served_by || "").toLowerCase().includes(q)
    );
  }

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--text-muted);">No unpaid customer invoices found.</td></tr>';
    return;
  }

  const _role = (USER_ROLE || localStorage.getItem("jomish_role") || "").toUpperCase();
  const canCancel = (["CEO", "ADMIN", "MANAGER", "TECH"].includes(_role) || USER_NAME === "System Technician") && _role !== "SUPERVISOR";

  tbody.innerHTML = list.map(inv => {
    const invNum = inv.invoice_number || inv.pos_order_id;
    const safeClient = (inv.client_name || "").replace(/'/g, "\\'");
    const safeServer = (inv.served_by || "").replace(/'/g, "\\'");
    const dStr = formatDisplayDate ? formatDisplayDate(inv.order_date || inv.transaction_date, true) : (new Date(inv.order_date || Date.now()).toLocaleDateString());
    return `
      <tr id="customer-invoice-row-${inv.pos_order_id}" data-pos-order-id="${inv.pos_order_id}" data-tx-id="${inv.transaction_id || ''}" style="border-bottom:1px solid rgba(255,255,255,0.05);">
        <td style="font-weight:700; color:var(--primary);">${formatDocNo("INV", invNum)}</td>
        <td style="font-size:0.83rem; color:var(--text-muted); white-space:nowrap;">${dStr}</td>
        <td style="font-weight:600;">${inv.client_name || 'Customer'}</td>
        <td style="color:var(--text-muted); font-size:0.85rem;">${inv.client_phone || '—'}</td>
        <td style="font-size:0.85rem;"><span style="background:rgba(79,70,229,0.1); color:var(--primary); padding:2px 8px; border-radius:10px; font-weight:600;">${inv.served_by || 'Cashier'}</span></td>
        <td style="font-weight:800; color:var(--text); white-space:nowrap;">UGX ${Number(inv.total_amount || 0).toLocaleString()}</td>
        <td><span style="background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3); padding:3px 9px; border-radius:12px; font-size:0.75rem; font-weight:700;">UNPAID</span></td>
        <td style="text-align:right; white-space:nowrap;">
          <button onclick="printPendingInvoice(${inv.pos_order_id}, ${inv.total_amount}, '${safeClient}', '${safeServer}', ${inv.invoice_number || 'null'})" class="sm-btn secondary" style="padding:4px 10px; font-size:0.78rem; margin-right:4px;">
            <i class="fa-solid fa-print"></i> Print
          </button>
          <button onclick="openPendingOrderCheckout(${inv.pos_order_id}, ${inv.total_amount}, '${safeClient}', '${safeServer}')" class="sm-btn primary" style="padding:4px 12px; font-size:0.78rem;">
            <i class="fa-solid fa-cash-register"></i> Collect Payment
          </button>
          ${canCancel ? `<button onclick="cancelPendingOrder(${inv.pos_order_id}, ${inv.transaction_id || 0})" class="sm-btn danger" style="padding:4px 10px; font-size:0.78rem; margin-left:4px;" title="Cancel / Void this invoice"><i class="fa-solid fa-trash"></i> Cancel</button>` : ''}
        </td>
      </tr>
    `;
  }).join("");
};

window.filterCustomerInvoices = function(term) {
  renderCustomerInvoicesTable(term);
};
