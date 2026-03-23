if(!_level0.timeMarkDone(_level0.bkgd.kioskModeWaitLong))
{
   gotoAndPlay(_currentframe - 1);
}
else
{
   clickToContinue.gotoAndPlay("blank");
   inst_faster_icons.activate();
}
