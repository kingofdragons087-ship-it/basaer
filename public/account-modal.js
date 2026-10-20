(function () {
  function initAccountModal() {
    const modal = document.getElementById("accountModal");
    const openBtn = document.getElementById("accountOpenBtn");
    const closeBtn = document.getElementById("accountCloseBtn");

    if (!modal || !openBtn || !closeBtn) return;

    openBtn.addEventListener("click", function (event) {
      event.preventDefault();
      modal.hidden = false;
      modal.style.display = "flex";
      document.body.classList.add("account-modal-open");
    });

    function closeAccount() {
      modal.hidden = true;
      modal.style.display = "none";
      document.body.classList.remove("account-modal-open");
    }

    closeBtn.addEventListener("click", closeAccount);

    modal.addEventListener("click", function (event) {
      if (event.target === modal) closeAccount();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !modal.hidden) closeAccount();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAccountModal);
  } else {
    initAccountModal();
  }
})();
