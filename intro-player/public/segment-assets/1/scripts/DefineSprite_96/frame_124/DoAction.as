if(!_level0.timeMarkDone(_level0.bkgd.kioskModeWaitTime))
{
   gotoAndPlay(_currentframe - 1);
}
else
{
   isActive = 0;
   _root.inst_easier_icons.activate();
}
