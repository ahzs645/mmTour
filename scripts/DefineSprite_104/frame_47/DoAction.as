if(!_level0.timeMarkDone(_level0.bkgd.kioskModeWaitTime))
{
   gotoAndPlay(_currentframe - 1);
}
else if(_level0.bkgd.OSVersion == "Per")
{
   _level0.bkgd.currScene = "ConnectedHome";
   _level0.doRelease("segment3.swf");
}
else
{
   _level0.bkgd.currScene = "ConnectedHome";
   _level0.doRelease("segment3.swf");
}
