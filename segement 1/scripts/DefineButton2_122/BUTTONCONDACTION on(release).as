on(release){
   if(!_parent.holdState)
   {
      _parent.gotoAndStop("noKiosk");
      _parent.rampVOout();
      _parent.clickToContinue.gotoAndPlay("blank");
      _parent.holdState = 1;
      isActive = 1;
      _parent.mc_faster.hideShots();
      _parent.mc_easier.hideShots();
      _parent.inst_easier_icons.unSelect();
      _parent.inst_faster_icons.unSelect();
      gotoAndPlay(36);
   }
}
