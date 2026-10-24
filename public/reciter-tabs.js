(() => {
  "use strict";

  const audioTab = document.getElementById("basaer-audio-tab");
  const videoTab = document.getElementById("basaer-video-tab");
  const audioPanel = document.getElementById("basaer-audio-panel");
  const videoPanel = document.getElementById("basaer-video-panel");

  if (!audioTab || !videoTab || !audioPanel || !videoPanel) {
    console.error("Basaer tabs: required elements are missing.");
    return;
  }

  function activate(which) {
    const audioActive = which === "audio";
    audioTab.setAttribute("aria-selected", String(audioActive));
    videoTab.setAttribute("aria-selected", String(!audioActive));
    audioPanel.hidden = !audioActive;
    videoPanel.hidden = audioActive;
  }

  audioTab.addEventListener("click", () => activate("audio"));
  videoTab.addEventListener("click", () => activate("video"));

  document.querySelectorAll(".recording-card").forEach(card => {
    const audio = card.querySelector("audio");
    if (!audio) return;

    audio.addEventListener("play", () => {
      document.querySelectorAll(".recording-card").forEach(other => {
        other.classList.remove("is-playing");
        if (other !== card) {
          const otherAudio = other.querySelector("audio");
          if (otherAudio) otherAudio.pause();
        }
      });
      card.classList.add("is-playing");
    });

    const stopWave = () => card.classList.remove("is-playing");
    audio.addEventListener("pause", stopWave);
    audio.addEventListener("ended", stopWave);
  });
})();
