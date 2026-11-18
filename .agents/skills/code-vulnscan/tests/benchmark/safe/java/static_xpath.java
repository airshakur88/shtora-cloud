// BENCHMARK: safe - constant XPath expression
import javax.xml.xpath.*;
import org.w3c.dom.Document;

public class SafeDirectoryLookup {
    public String firstUsername(Document directory) throws Exception {
        XPath xpath = XPathFactory.newInstance().newXPath();
        return xpath.evaluate("//user[1]/name", directory);
    }
}
