if(!_level0.timeMarkDone(_level0.bkgd.kioskModeWaitTime))
{
   gotoAndPlay(_currentframe - 1);
}
else if(_level0.bkgd.OSVersion == "Per")
{
   _level0.restartTour();
}
else
{
   _level0.bkgd.currScene = "StartHere";
   _level0.doRelease("segment5.swf");
}
