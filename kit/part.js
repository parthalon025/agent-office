/* Agent Office kit x1.7.5: a custom role with its own workstation. Load after bundle.js and before you mount.
   Build meshes inside the builder: the nav grid reads them, and bots walk around them. */
(function () {
  var O = AgentOffice.office, P = O.Parts, H = O.helpers;
  O.ROLES.legal = { label: "Legal", short: "Legal", icon: "role-analyst",
    tasks: ["Reading the contract", "Marking clauses", "Writing the redline"], asks: ["Approve the redline?"] };
  // K: material kit (K.t(token) gives a themed material), g: room group, x/z: station centre, i: index, anim: per-frame list.
  O.Work.legal = function (K, g, x, z, i, anim) {
    P.rectDesk(K, g, x, z - .1, 2.4);                                    // desk: an obstacle
    var screen = P.monitor(K, g, x - .3, z - .45, "analyst");            // screen glows in the status color
    H.mesh(H.box(.6, .9, .5), K.t("scene-dark"), x + 1, .45, z - .3, g); // file cabinet: an obstacle
    var mat = H.mesh(H.box(1.6, .02, 1), K.t("scene-rug"), x, .07, z + 2.4, g);
    mat.userData.noNav = 1;                                              // decor that bots may cross
    return { seat: H.seatAt(K, g, x, z), screen: screen };              // seat: where the bot sits
  };
})();
