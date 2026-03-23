if(!_level0.timeMarkDone(_level0.bkgd.kioskModeWaitTime))
{
   gotoAndPlay(_currentframe - 1);
}
else if(_level0.bkgd.OSVersion == "Per")
{
   _level0.bkgd.currScene = "SafeAndEasy";
   _level0.doRelease("segment1.swf");
}
else
{
   _level0.restartTour();
}
